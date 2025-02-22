# chain_setup.py
from langchain_ollama import ChatOllama
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationalRetrievalChain

def create_conversational_chain(retriever, model):
    llm = ChatOllama(model=model)
    memory = ConversationBufferMemory(memory_key="chat_history", return_messages=True)
    qa_chain = ConversationalRetrievalChain.from_llm(llm=llm, retriever=retriever, memory=memory)
    return qa_chain