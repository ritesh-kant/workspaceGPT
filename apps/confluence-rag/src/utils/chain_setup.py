# chain_setup.py
from langchain_ollama import ChatOllama
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationalRetrievalChain
from langchain.prompts import PromptTemplate


def create_conversational_chain(retriever, model):
    llm = ChatOllama(model=model)
    memory = ConversationBufferMemory(memory_key="chat_history", return_messages=True,   model_kwargs={"device": "cuda"}  # Forces GPU usage
                                      )
    # Custom Prompt Template
    prompt_template = PromptTemplate(
        input_variables=["chat_history", "question", "context"],
        template="""
        You are a helpful AI assistant. Always format your responses in **Markdown**.

        If the user greets you with "hello", "hi", "good morning", "good evening", "hey", etc., then respond with a friendly greeting and avoid using the retrieved context.

        Otherwise, use the retrieved context to answer the user’s question.

        Context: 
        ```
        {context}
        ```

        Chat History:
        ```
        {chat_history}
        ```

        User Question:
        ```
        {question}
        ```

        **Answer (formatted in Markdown):**
        """
    )

    qa_chain = ConversationalRetrievalChain.from_llm(
        llm=llm, retriever=retriever, memory=memory, combine_docs_chain_kwargs={"prompt": prompt_template})
    return qa_chain


def create_streaming_chain(retriever, model, callbacks=None):
    """Create a conversational chain with streaming capabilities."""
    llm = ChatOllama(model=model, callbacks=callbacks)
    memory = ConversationBufferMemory(
        memory_key="chat_history", return_messages=True, model_kwargs={"device": "cuda"})

    # Custom Prompt Template
    prompt_template = PromptTemplate(
        input_variables=["chat_history", "question", "context"],
        template="""You are an workspace AI assistant helping with questions.
        
        Context: {context}
        Chat History: {chat_history}
        User Question: {question}
        
        Answer:"""
    )

    qa_chain = ConversationalRetrievalChain.from_llm(
        llm=llm, retriever=retriever, memory=memory, combine_docs_chain_kwargs={"prompt": prompt_template})
    return qa_chain
