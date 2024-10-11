# Dockerfile for WebSocket service (ws.py)
FROM python:3.9

# Create and set the working directory inside the container
WORKDIR /app

# Install the necessary Python libraries
COPY requirements.txt .
RUN pip install -r requirements.txt --timeout=120

# Copy the rest of the application code
COPY . .

# Expose the WebSocket port
EXPOSE 3000

# Start the FastAPI application using Uvicorn
CMD ["uvicorn", "ws:app", "--host", "0.0.0.0", "--port", "3000"]
