FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for OpenCV and Node.js
RUN apt-get update && apt-get install -y \
    curl \
    libgl1 \
    libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
# Explicitly install CPU-only version of PyTorch to save ~4GB of disk space (CUDA is not needed on standard Droplets)
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm install

# Copy application files
COPY . .

# Build Vite frontend
RUN npm run build

# Expose ports (3001 for Node, 8000 for Python)
EXPOSE 3001
EXPOSE 8000
