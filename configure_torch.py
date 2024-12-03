import torch
import os
import multiprocessing

# Configure PyTorch for CPU
num_threads = max(1, multiprocessing.cpu_count() - 1)
torch.set_num_threads(num_threads)
os.environ["OMP_NUM_THREADS"] = str(num_threads)
os.environ["MKL_NUM_THREADS"] = str(num_threads)

print(f"PyTorch configured for CPU with {num_threads} threads")
print(f"PyTorch version: {torch.__version__}")
print(f"Number of threads: {torch.get_num_threads()}")
