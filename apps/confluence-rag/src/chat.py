from main import WorkspaceAssistant
import streamlit as st
from langchain.callbacks.base import BaseCallbackHandler

# Add a streaming callback handler
class StreamHandler(BaseCallbackHandler):
    def __init__(self, container):
        self.container = container
        self.text = ""

    def on_llm_new_token(self, token: str, **kwargs):
        self.text += token
        self.container.markdown(self.text)

def main():
    # Custom CSS to reduce space above title
    st.markdown("""
        <style>
        .block-container {
            padding-top: 2rem;
            padding-bottom: 0rem;
        }
        /* Add some margin to the button container */
        .stButton {
            margin-top: 15px;
        }
        </style>
        """, unsafe_allow_html=True)
    
    # Initialize the assistant only once using session state
    if "assistant" not in st.session_state:
        st.session_state.assistant = WorkspaceAssistant()
        try:
            st.session_state.assistant.initialize()
        except ValueError as e:
            st.error(f"Error: {e}")
            return

    # Streamlit UI
    # Create a container for the title and new chat button
    header_container = st.container()
    with header_container:
        # Use columns to position the title and button
        col1, col2 = st.columns([0.8, 0.2])
        with col1:
            st.title("💬 Workspace GPT")
        with col2:
            # Add some vertical space before the button
            st.write("")
            # Add the New Chat button to the right column
            if st.button("🔄 New Chat", key="new_chat_btn"):
                # Reset the conversation
                st.session_state.messages = st.session_state.assistant.new_chat()
                st.rerun()  # Rerun the app to refresh the UI
    
    st.write("Ask questions about your workspace")

    # Initialize chat history
    if "messages" not in st.session_state:
        st.session_state.messages = []

    # Display chat history
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

    # User input
    if user_input := st.chat_input("Ask something..."):
        # Add user message to session state
        st.session_state.messages.append({"role": "user", "content": user_input})

        # Display user message
        with st.chat_message("user"):
            st.markdown(user_input)

        # Display bot response with streaming
        with st.chat_message("assistant"):
            # Create a placeholder for the streaming response
            response_placeholder = st.empty()
            # Create a streaming handler
            stream_handler = StreamHandler(response_placeholder)
            
            # Get streaming response from LangChain
            full_response = st.session_state.assistant.chat(user_input, stream_handler)
            
            # Add bot response to session state
            st.session_state.messages.append({"role": "assistant", "content": full_response})

if __name__ == "__main__":
    main()
