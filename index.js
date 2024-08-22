const fastify = require('fastify')({ 
  logger: true,
  bodyLimit: 100 * 1024 * 1024 // 100 MB limit
});
const fs = require('fs').promises;
const PDFParser = require('pdf-parse');
const axios = require('axios');

const PORT = process.env.PORT || 10000;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-3-opus-20240229';

fastify.register(require('@fastify/static'), {
  root: __dirname,
  prefix: '/public/',
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fieldSize: 100 * 1024 * 1024 // 100 MB limit
  }
});

let pdfContexts = {};
let systemPrompt = '';
let conversationHistory = [];

const callClaudeAPI = async (messages, systemPrompt) => {
  try {
    const response = await axios.post(CLAUDE_API_URL, {
      model: CLAUDE_MODEL,
      messages: messages,
      system: systemPrompt,
      max_tokens: 1000
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    });
    return response.data.content[0].text;
  } catch (error) {
    console.error('Error calling Claude API:', error.response ? error.response.data : error.message);
    throw new Error('Failed to get response from Claude API: ' + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
};

fastify.post('/upload', async (request, reply) => {
  const files = await request.files();
  let uploadedFiles = [];

  for await (const file of files) {
    const buffer = await file.toBuffer();
    try {
      const pdf = await PDFParser(buffer);
      pdfContexts[file.filename] = pdf.text;
      uploadedFiles.push(file.filename);
    } catch (error) {
      console.error(`Error processing ${file.filename}: ${error.message}`);
    }
  }

  systemPrompt = `You are an assistant that answers questions based on the following PDF contents: ${Object.values(pdfContexts).join(' ')}`;
  conversationHistory = []; // Reset conversation history

  return { success: true, message: `PDFs uploaded and processed successfully: ${uploadedFiles.join(', ')}` };
});

fastify.post('/ask', async (request, reply) => {
  const { question } = request.body;
  if (!question) {
    return { success: false, message: 'No question provided.' };
  }
  if (Object.keys(pdfContexts).length === 0) {
    return { success: false, message: 'Please upload at least one PDF first.' };
  }

  try {
    conversationHistory.push({ role: "user", content: question });
    const answer = await callClaudeAPI(conversationHistory, systemPrompt);
    conversationHistory.push({ role: "assistant", content: answer });
    return { success: true, answer };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

fastify.get('/', async (request, reply) => {
  reply.type('text/html').send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PDF Chat Interface</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
        <div class="container max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-lg">
            <h1 class="text-2xl font-bold mb-6">PDF Chat Interface</h1>
            <p class="mb-4">Upload a PDF file and ask any question to get answers</p>
            <div class="mb-6">
                <label for="pdfInput" class="block text-sm font-medium text-gray-700 mb-2">
                    Upload PDF <span class="text-red-500">*</span>
                </label>
                <div id="fileUploadArea" class="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md">
                    <div class="space-y-1 text-center">
                        <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                            <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                        <div class="flex text-sm text-gray-600">
                            <label for="pdfInput" class="relative cursor-pointer bg-white rounded-md font-medium text-indigo-600 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500">
                                <span>Upload a file</span>
                                <input id="pdfInput" name="pdfInput" type="file" accept=".pdf" class="sr-only" multiple>
                            </label>
                            <p class="pl-1">or drag and drop</p>
                        </div>
                        <p class="text-xs text-gray-500">PDF up to 10MB</p>
                    </div>
                </div>
                <div id="fileList" class="mt-4"></div>
            </div>
            <div class="mb-6">
                <div class="flex space-x-2">
                    <input type="text" id="questionInput" placeholder="Begin typing..." class="flex-grow p-2 border rounded">
                    <button onclick="askQuestion()" id="askButton" class="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600">Ask</button>
                </div>
            </div>
            <div id="chatContainer" class="mt-6 p-4 bg-gray-100 rounded h-64 overflow-y-auto">
                <p class="text-gray-500 italic">Ask and we'll parse through the details to give you a detailed answer</p>
            </div>
        </div>
        <script>
            let uploadedFiles = new Set();

            function updateFileList() {
                const fileList = document.getElementById('fileList');
                fileList.innerHTML = '';
                uploadedFiles.forEach(fileName => {
                    const fileItem = document.createElement('div');
                    fileItem.className = 'flex items-center justify-between bg-gray-100 p-2 rounded mt-2';
                    fileItem.innerHTML = \`
                        <span>\${fileName}</span>
                        <button onclick="removeFile('\${fileName}')" class="text-red-500 hover:text-red-700">
                            <i class="fas fa-times"></i>
                        </button>
                    \`;
                    fileList.appendChild(fileItem);
                });
            }

            function removeFile(fileName) {
                uploadedFiles.delete(fileName);
                updateFileList();
            }

            async function handleFileUpload(files) {
                const formData = new FormData();
                for (let file of files) {
                    if (file.size <= 10 * 1024 * 1024) { // 10MB limit
                        formData.append('pdf', file);
                        uploadedFiles.add(file.name);
                    } else {
                        alert(\`\${file.name} is too large. Please upload files smaller than 10MB.\`);
                    }
                }
                updateFileList();

                try {
                    const response = await fetch('/upload', {
                        method: 'POST',
                        body: formData
                    });
                    const result = await response.json();
                    if (result.success) {
                        addMessageToChat('system', 'PDFs uploaded successfully. You can now ask questions about their content.');
                    } else {
                        alert(result.message);
                    }
                } catch (error) {
                    alert('Error uploading PDF: ' + error.message);
                }
            }

            document.getElementById('pdfInput').addEventListener('change', (event) => {
                handleFileUpload(event.target.files);
            });

            const dropZone = document.getElementById('fileUploadArea');

            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, preventDefaults, false);
            });

            function preventDefaults(e) {
                e.preventDefault();
                e.stopPropagation();
            }

            ['dragenter', 'dragover'].forEach(eventName => {
                dropZone.addEventListener(eventName, highlight, false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, unhighlight, false);
            });

            function highlight(e) {
                dropZone.classList.add('border-indigo-500');
            }

            function unhighlight(e) {
                dropZone.classList.remove('border-indigo-500');
            }

            dropZone.addEventListener('drop', handleDrop, false);

            function handleDrop(e) {
                const dt = e.dataTransfer;
                const files = dt.files;
                handleFileUpload(files);
            }

            async function askQuestion() {
                const questionInput = document.getElementById('questionInput');
                const question = questionInput.value.trim();
                if (!question) {
                    alert('Please enter a question');
                    return;
                }
                addMessageToChat('user', question);
                try {
                    const response = await fetch('/ask', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ question })
                    });
                    const result = await response.json();
                    if (result.success) {
                        addMessageToChat('assistant', result.answer);
                    } else {
                        addMessageToChat('system', 'Error: ' + result.message);
                    }
                    questionInput.value = '';
                } catch (error) {
                    addMessageToChat('system', 'Error asking question: ' + error.message);
                }
            }

            function addMessageToChat(role, content) {
                const chatContainer = document.getElementById('chatContainer');
                const messageDiv = document.createElement('div');
                messageDiv.className = role === 'user' ? 'bg-blue-100 p-2 rounded mb-2' : 'bg-green-100 p-2 rounded mb-2';
                messageDiv.textContent = content;
                chatContainer.appendChild(messageDiv);
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }

            document.addEventListener('DOMContentLoaded', function() {
                const questionInput = document.getElementById('questionInput');
                const askButton = document.getElementById('askButton');
                const pdfInput = document.getElementById('pdfInput');

                questionInput.addEventListener('keypress', function(event) {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        askButton.click();
                    }
                });

                pdfInput.addEventListener('change', function() {
                    uploadPDF();
                });
            });
        </script>
    </body>
    </html>
  `);
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();