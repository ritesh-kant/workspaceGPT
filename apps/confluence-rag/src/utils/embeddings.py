# embeddings.py
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import HuggingFaceEmbeddings

def store_in_db(chunks, db_name):
    embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2", show_progress=True)
    vectorstore = Chroma.from_documents(chunks, embeddings, persist_directory=db_name)
    return vectorstore

def retrieve_from_db(vectorstore):
    retriever = vectorstore.as_retriever(search_kwargs={"k": 20})
    return retriever