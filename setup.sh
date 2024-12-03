#!/bin/bash

# Create a virtual environment
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate

# Install PyTorch optimized for CPU
pip3 install --upgrade pip
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# Install OpenAI Whisper
pip3 install --upgrade openai-whisper

# Create a PyTorch configuration script
cat > configure_torch.py << EOL
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
EOL

# Run the configuration
python3 configure_torch.py

# Create an activation script for the environment
cat > activate_env.sh << EOL
#!/bin/bash
source venv/bin/activate
export OMP_NUM_THREADS=\$(python3 -c 'import multiprocessing; print(max(1, multiprocessing.cpu_count() - 1))')
export MKL_NUM_THREADS=\$OMP_NUM_THREADS
EOL

chmod +x activate_env.sh 