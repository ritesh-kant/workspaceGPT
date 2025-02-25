# config.py
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

MODEL = os.getenv("MODEL", "llama3.2")  # Default to "llama3.2" if MODEL not in .env
DB_NAME = os.getenv("DB_NAME", "vector_db") # Default to "vector_db" if DB_NAME not in .env
OLLAMA_API = os.getenv("OLLAMA_API", "http://localhost:11434/api/chat") # Default if not in .env

# Construct PDF_FOLDER path -  no need to put this in .env unless you want to make it configurable
CUR_DIR = Path(__file__).parent.parent.parent
ROOT_DIR = CUR_DIR.parent.parent
PDF_FOLDER = ROOT_DIR / ".data" / "confluence" / "cleanPdfs"
MD_FOLDER = ROOT_DIR / ".data" / "confluence" / "cleanPdfs"

# Document source type: "pdf" or "md"
DOC_SOURCE = os.getenv("DOC_SOURCE", "pdf").lower()  # Default to PDF if not specified

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL") #  Now reads from .env or system env
