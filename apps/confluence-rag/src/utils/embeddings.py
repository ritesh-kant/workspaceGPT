# embeddings.py
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_core.vectorstores import VectorStoreRetriever
from langchain_core.documents import Document
from typing import List
from .config import EMBEDDING_MODEL, CUR_DIR
import os

def store_in_db(chunks: List[Document], db_name: str) -> FAISS:
    persist_directory = CUR_DIR/db_name
    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL, show_progress=True)

    vectorstore: FAISS = FAISS.from_documents(
        chunks, embeddings)
    vectorstore.save_local(persist_directory)
    return vectorstore

def load_from_db(db_name: str) -> FAISS:
    persist_directory = CUR_DIR/db_name
    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL, show_progress=True)
    
    print(f"🚥 Loading existing FAISS index from database {persist_directory}\n")
    vectorstore: FAISS = FAISS.load_local(
        persist_directory, embeddings, allow_dangerous_deserialization=True)
    
    faiss_index = vectorstore.index

    num_vectors = faiss_index.ntotal

    print(f"Number of vectors in the FAISS index: {num_vectors}")

    return vectorstore

def check_db_exists(db_name: str) -> bool:
    persist_directory = CUR_DIR/db_name
    return os.path.exists(os.path.join(persist_directory, "index.faiss"))

def retrieve_from_db(vectorstore: VectorStoreRetriever) -> VectorStoreRetriever:
    retriever = vectorstore.as_retriever(
        search_type="mmr",
        search_kwargs={
            "k": 6,                # Final number of chunks to return
            "fetch_k": 30,         # Initial pool size
            "score_threshold": 0.7
        })
    return retriever
