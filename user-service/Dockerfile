FROM python:3.9

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt --timeout=120

COPY . .

EXPOSE 5002

CMD ["python", "app.py"]
