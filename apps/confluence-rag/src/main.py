# main.py
from utils.config import PDF_FOLDER, DB_NAME, MODEL
from utils.loader import load_pdfs
from utils.chunker import chunk_documents
from utils.embeddings import store_in_db, retrieve_from_db
from utils.chain_setup import create_conversational_chain
import gradio as gr

class WorkspaceAssistant:
    def __init__(self):
        self.vectorstore = None
        self.qa_chain = None

    def initialize(self):
        """Initialize the assistant by loading documents and setting up the QA chain."""
        # Load and process documents
        documents = load_pdfs(PDF_FOLDER)
        if not documents:
            raise ValueError("No documents found")
        
        print(f"Loaded {len(documents)} documents.")
        chunks = chunk_documents(documents)

        # Convert text into embeddings and store in vector DB
        self.vectorstore = store_in_db(chunks, DB_NAME)
        retriever = retrieve_from_db(self.vectorstore)
        
        # Create conversational chain
        self.qa_chain = create_conversational_chain(retriever, MODEL)

    def chat(self, question, history):
        """Handle chat interactions."""
        if question.lower() in ["hi", "hello"]:
            return "Hi, I am Workspace Assistant. How can I help you?"
        
        result = self.qa_chain.invoke({"question": question})
        return result["answer"]

def main():
    # Initialize the assistant
    assistant = WorkspaceAssistant()
    try:
        assistant.initialize()
    except ValueError as e:
        print(f"Error: {e}")
        return
    
    # Launch Gradio interface
    view = gr.ChatInterface(
        assistant.chat,
        title="Workspace Assistant",
        description="Ask questions about your workspace documents",
    ).launch(inbrowser=True)

if __name__ == "__main__":
    main()