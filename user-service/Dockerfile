FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

RUN pip install pytest pytest-mock

COPY . .
ENV PYTHONPATH=/app

EXPOSE 5002

CMD ["pytest", "--maxfail=1", "--disable-warnings", "-v"]
