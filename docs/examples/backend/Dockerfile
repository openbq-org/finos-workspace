FROM python:3.14.8-slim@sha256:fbecd461fc72d21b2143c6eaba25143738079154a6d0ea3da3aec724f50eed4a

ARG SQL_EXPLORER_VERSION
ARG AG_GRID_VERSION

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SQL_EXPLORER_PACKAGE=/opt/plugins/sql-explorer \
    AG_GRID_PACKAGE=/opt/plugins/ag-grid \
    SQL_EXPLORER_DATA=/data \
    PYTHONPATH=/opt/plugins/sql-explorer/backend:/opt/plugins/ag-grid/backend

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-compile --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY sql-explorer/dist/sql-explorer/${SQL_EXPLORER_VERSION} /opt/plugins/sql-explorer
COPY ag-grid/dist/ag-grid/${AG_GRID_VERSION} /opt/plugins/ag-grid
COPY backend /opt/examples
RUN python -c "import sys; sys.path.insert(0, '/opt/examples'); import data; data.write_files('/data')"

USER 65534:65534
WORKDIR /opt/examples
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--no-access-log"]
