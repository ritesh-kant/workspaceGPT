# chunker.py
from langchain_text_splitters import RecursiveCharacterTextSplitter

def chunk_documents(documents):
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    return text_splitter.split_documents(documents)