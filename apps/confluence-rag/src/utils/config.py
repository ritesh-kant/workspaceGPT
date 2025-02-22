# config.py
from pathlib import Path

MODEL = "llama3.2"
DB_NAME = "vector_db"
OLLAMA_API = "http://localhost:11434/api/chat"

PDF_FOLDER = Path(__file__).parent.parent.parent.parent.parent / "data" / "confluence" / "pdfs"