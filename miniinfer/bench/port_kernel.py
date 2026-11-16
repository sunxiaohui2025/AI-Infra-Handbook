"""第 144 讲：同一个 RMSNorm 的三种写法，在本机（Apple M2 的 GPU）真实对比。
   写法一：用框架的基础算子组合（miniinfer 现在的做法，一步要下发五六个 kernel）；
   写法二：同样是组合，但只让归约在 FP32 里做（第 142 讲量过的那处写法差异）；
   写法三：手写一个融合 kernel。本机的“厂商 kernel 语言”是 Metal，写法和 HIP、CUDA 很像：
          一个线程组处理一行，组内先做 SIMD 组归约再跨组归约，然后把结果写回去。
注意线程组里的 SIMD 宽度：Apple 这块 GPU 报告 32，海光的波前是 64（第 135、136 讲）——
这个数字写死在 kernel 里就是换卡时的静默错误来源，所以下面从设备属性里读出来再打印。"""
import os, sys, time
import torch
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SRC = r"""
#include <metal_stdlib>
using namespace metal;
kernel void rms_norm_f32(
    device const float* x   [[buffer(0)]],
    device const float* w   [[buffer(1)]],
    device float* out       [[buffer(2)]],
    constant uint& d        [[buffer(3)]],
    constant float& eps     [[buffer(4)]],
    uint row      [[threadgroup_position_in_grid]],
    uint lane     [[thread_position_in_threadgroup]],
    uint nthreads [[threads_per_threadgroup]]) {
  threadgroup float partial[32];
  float acc = 0.0f;
  // 每条通道按步长 nthreads 扫自己负责的那些列，边读边累加平方
  for (uint i = lane; i < d; i += nthreads) { float v = x[row * d + i]; acc += v * v; }
  acc = simd_sum(acc);                                  // 一个 SIMD 组内求和（宽度由硬件决定）
  if (lane % 32 == 0) partial[lane / 32] = acc;         // 每组的结果放进共享内存
  threadgroup_barrier(mem_flags::mem_threadgroup);
  if (lane == 0) {                                      // 0 号通道把各组的和加起来，算出缩放系数
    float s = 0.0f;
    for (uint k = 0; k < nthreads / 32; ++k) s += partial[k];
    partial[0] = rsqrt(s / float(d) + eps);
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);
  float scale = partial[0];
  for (uint i = lane; i < d; i += nthreads) out[row * d + i] = x[row * d + i] * scale * w[i];
}
"""
lib = torch.mps.compile_shader(SRC)
kern = lib.rms_norm_f32
print(f"编译出的 kernel：SIMD 宽度 {kern.thread_execution_width}，一个线程组最多 {kern.max_threads_per_threadgroup} 个线程")

EPS, THREADS = 1e-6, 256


def composed(x, w):                        # 写法一：基础算子组合
    var = x.pow(2).mean(-1, keepdim=True)
    return x * torch.rsqrt(var + EPS) * w


def composed_fp32_reduce(x, w):            # 写法二：只让归约升到 FP32
    var = x.pow(2).mean(-1, keepdim=True, dtype=torch.float32).to(x.dtype)
    return x * torch.rsqrt(var + EPS) * w


def fused(x, w):                           # 写法三：手写融合 kernel，一次读、一次写
    out = torch.empty_like(x)
    kern(x, w, out, x.shape[-1], EPS, threads=x.shape[0] * THREADS, group_size=THREADS)
    return out


def bench(f, x, w, n):
    f(x, w); torch.mps.synchronize()
    t0 = time.perf_counter()
    for _ in range(n):
        f(x, w)
    torch.mps.synchronize()
    return (time.perf_counter() - t0) / n * 1e6


torch.manual_seed(0)
d = 1024
for rows, label, n in [(1, "decode（1 行）", 3000), (199, "prefill（199 行）", 2000), (4096, "大 batch（4096 行）", 500)]:
    x = torch.randn(rows, d, device="mps") * 10
    w = torch.rand(d, device="mps") + 0.5
    ref = composed(x.cpu().double(), w.cpu().double())   # 参考答案在 CPU 上用 FP64 算
    print(f"\n{label}，d = {d}，FP32：")
    print(f"{'微秒':>8}{'相对误差':>11}{'有效带宽':>12}  写法")
    for name, f in [("基础算子组合（5 个 kernel）", composed), ("组合 + 归约用 FP32", composed_fp32_reduce), ("手写融合 kernel（1 个）", fused)]:
        us = bench(f, x, w, n)
        err = float((f(x, w).cpu().double() - ref).norm() / ref.norm())
        gbs = rows * d * 4 * 2 / (us * 1e-6) / 1e9          # 读一遍写一遍
        print(f"{us:>8.1f}{err:>11.1e}{gbs:>10.1f} GB/s  {name}")
