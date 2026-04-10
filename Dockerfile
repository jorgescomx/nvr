FROM python:3.11-alpine

# Install ffmpeg and required dependencies
RUN apk update && \
    apk add --no-cache ffmpeg nodejs npm tzdata && \
    rm -rf /var/cache/apk/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Build the frontend (if we copy it into the container)
# Actually, the frontend will be built in the container runtime 
# or via multi-stage to serve statically via Flask
RUN cd frontend && npm install && npm run build || true

ENV PYTHONUNBUFFERED=1

CMD ["python", "app.py"]
