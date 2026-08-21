FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Proxy configuration
    HTTP_PROXY=http://proxy.etisalat.corp.ae:8080 \
    HTTPS_PROXY=http://proxy.etisalat.corp.ae:8080 \
    http_proxy=http://proxy.etisalat.corp.ae:8080 \
    https_proxy=http://proxy.etisalat.corp.ae:8080 \
    NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/16,192.168.0.0/24,ai-admin-module-py,dx12348.etisalat.corp.ae,*.dx12348.etisalat.corp.ae \
    no_proxy=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/16,192.168.0.0/24,ai-admin-module-pydx12348.etisalat.corp.ae,*.dx12348.etisalat.corp.ae

WORKDIR /app

#RUN apt-get update && apt-get install -y --no-install-recommends \
#    build-essential \
#    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt --proxy http://gpalani:audiGG14$$09@proxy.etisalat.corp.ae:8080

COPY . /app

RUN mkdir -p /app/data /app/logs

EXPOSE 8002

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]