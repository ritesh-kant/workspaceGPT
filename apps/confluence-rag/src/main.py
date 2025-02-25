# main.py
from utils.config import PDF_FOLDER, MD_FOLDER, DB_NAME, MODEL, DOC_SOURCE
from utils.loader import load_documents
from utils.chunker import chunk_documents
from utils.embeddings import store_in_db, retrieve_from_db, check_db_exists, load_from_db
from utils.chain_setup import create_conversational_chain
import gradio as gr

class WorkspaceAssistant:
    def __init__(self):
        self.vectorstore = None
        self.qa_chain = None

    def initialize(self):
        """Initialize the assistant by loading documents and setting up the QA chain."""
        # Check if database already exists
        if check_db_exists(DB_NAME):
            # Load existing database
            self.vectorstore = load_from_db(DB_NAME)
        else:
            # Determine which folder to use based on DOC_SOURCE
            folder = MD_FOLDER if DOC_SOURCE == "md" else PDF_FOLDER
            
            # Load and process documents
            print(f"📄 Loading {DOC_SOURCE} documents from {folder}\n")
            documents = load_documents(folder, DOC_SOURCE)
            if not documents:
                raise ValueError(f"No {DOC_SOURCE} documents found in {folder}")

            print(f"✅ Loaded {len(documents)} documents.\n")
            chunks = chunk_documents(documents)

            # Convert text into embeddings and store in vector DB
            print(f"⏳ Creating new FAISS database for {DB_NAME}\n")
            self.vectorstore = store_in_db(chunks, DB_NAME)
        
        # Create retriever from vectorstore
        retriever = retrieve_from_db(self.vectorstore)

        # Create conversational chain
        self.qa_chain = create_conversational_chain(retriever, MODEL)

    def chat(self, question, history):
        """Handle chat interactions."""
        # if question.lower() in ["hi", "hello"]:
        #     return "Hi, I am Workspace Assistant. How can I help you?"

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
