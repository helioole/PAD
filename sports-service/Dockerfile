FROM python:3.9

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN pip install protobuf==3.20.3 grpcio grpcio-tools

COPY . .

RUN python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. sports_service.proto

EXPOSE 50051

CMD ["python", "app.py"]
