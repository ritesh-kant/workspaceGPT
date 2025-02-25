# config.py
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Default to "llama3.2" if MODEL not in .env
MODEL = os.getenv("MODEL", "llama3.2")

# Default if not in .env
OLLAMA_API = os.getenv("OLLAMA_API", "http://localhost:11434/api/chat")

# Construct PDF_FOLDER path -  no need to put this in .env unless you want to make it configurable
CUR_DIR = Path(__file__).parent.parent.parent
ROOT_DIR = CUR_DIR.parent.parent
PDF_FOLDER = ROOT_DIR / ".data" / "confluence" / "mds"
MD_FOLDER = ROOT_DIR / ".data" / "confluence" / "mds"

# Active app mode
ACTIVE_APP_MODE = os.getenv("APP_MODE")

# App modes
APP_MODES = {
    "LITE": "LITE",
    "STANDARD": "STANDARD",
    "EXPERT": "EXPERT"
}

# Document source type: "pdf" or "md"
DOC_SOURCE = "pdf" if ACTIVE_APP_MODE == APP_MODES["LITE"] else "md"

#  Embedding model based on app mode
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL_"+ACTIVE_APP_MODE)

# Default to "vector_db" if DB_NAME not in .env
DB_NAME = "vector_db_"+ACTIVE_APP_MODE.lower()
