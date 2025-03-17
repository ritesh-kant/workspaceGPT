# api.py
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn
from typing import Optional
import asyncio

# Import the WorkspaceAssistant from main.py
from main import WorkspaceAssistant

# Define request models
class QuestionRequest(BaseModel):
    question: str
    stream: Optional[bool] = False

# Create FastAPI app and initialize assistant
app = FastAPI(title="Workspace Assistant API")
assistant = WorkspaceAssistant()

@app.on_event("startup")
async def startup_event():
    """Initialize the assistant when the API starts up"""
    assistant.initialize()

@app.post("/v1/chat/completions")
async def chat_endpoint(request: QuestionRequest):
    """Endpoint to chat with the assistant"""
    try:
        print(f"Received request: {request}")
        if not request.stream:
            # Regular non-streaming response
            response = assistant.chat(request.question)
            return {"answer": response}
        else:
            # Streaming response
            async def stream_response():
                # Create a simple async generator for streaming
                chunks = []
                
                async def collect_chunks(chunk):
                    chunks.append(chunk)
                    yield f"data: {chunk}\n\n"
                
                await asyncio.to_thread(
                    assistant.chat, 
                    request.question, 
                    stream_handler=collect_chunks
                )
                
                # Final chunk with complete response
                yield f"data: [DONE]\n\n"
            
            return StreamingResponse(
                stream_response(),
                media_type="text/event-stream"
            )
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Error in chat_endpoint: {str(e)}\n{error_details}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/chat/completions/new_chat")
async def new_chat_endpoint():
    """Endpoint to start a new conversation"""
    assistant.new_chat()
    return {"status": "success", "message": "New conversation started"}

@app.post("/test")
def test_endpoint():
    """Test endpoint to check if the API is running"""
    return {"message": "API is running"}

def main():
    """Run the FastAPI application with Uvicorn"""
    uvicorn.run(app, host="0.0.0.0", port=8000)

if __name__ == "__main__":
    main()