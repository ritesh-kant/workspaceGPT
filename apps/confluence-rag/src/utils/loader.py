# loader.py
from langchain_community.document_loaders import PyMuPDFLoader, UnstructuredMarkdownLoader
import os
from pathlib import Path

def load_pdfs(pdf_folder):
    documents = []
    for file in os.listdir(pdf_folder):
        if file.endswith(".pdf"):
            loader = PyMuPDFLoader(os.path.join(pdf_folder, file))
            documents.extend(loader.load())
    return documents

def load_markdown_files(md_folder):
    documents = []
    for file in os.listdir(md_folder):
        if file.endswith(".md"):
            loader = UnstructuredMarkdownLoader(os.path.join(md_folder, file))
            documents.extend(loader.load())
    return documents

def load_documents(folder, source_type="pdf"):
    """
    Load documents from the specified folder based on source type.
    
    Args:
        folder (str): Path to the folder containing documents
        source_type (str): Type of documents to load ("pdf" or "md")
        
    Returns:
        list: List of loaded documents
    """
    if source_type == "pdf":
        return load_pdfs(folder)
    elif source_type == "md":
        return load_markdown_files(folder)
    else:
        raise ValueError(f"Unsupported document source type: {source_type}")
