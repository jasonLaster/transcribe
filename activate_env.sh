#!/bin/bash
source venv/bin/activate
export OMP_NUM_THREADS=$(python3 -c 'import multiprocessing; print(max(1, multiprocessing.cpu_count() - 1))')
export MKL_NUM_THREADS=$OMP_NUM_THREADS
