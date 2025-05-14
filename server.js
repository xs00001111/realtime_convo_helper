
const encoding = 'LINEAR16';
const sampleRateHertz = 16000;
const languageCode = 'en-US';
const streamingLimit = 60000; 


const {Writable} = require('stream');
const recorder = require('node-record-lpcm16');
const {GoogleAuth, grpc} = require('google-gax');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const events = require('events');
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');

const log = require('electron-log');



// Ensure PATH prioritizes our bundled binaries over system binaries
if (process.env.NODE_ENV === 'production') {
  // In production, use the bundled binaries in the resources directory
  const binPath = path.join(process.resourcesPath, 'bin');
  process.env.PATH = `${binPath}:${process.env.PATH}`;
  console.log('Production mode: Using bundled binaries from', binPath);
} else {
  // In development, use the local bin directory
  const binPath = path.join(__dirname, 'bin');
  process.env.PATH = `${binPath}:${process.env.PATH}`;
  console.log('Development mode: Using bundled binaries from', binPath);
}

// Verify sox binary exists and is executable
const soxBinPath = process.env.NODE_ENV === 'production'
  ? path.join(process.resourcesPath, 'bin', 'sox')
  : path.join(__dirname, 'bin', 'sox');

try {
  fs.accessSync(soxBinPath, fs.constants.X_OK);
  console.log(`Sox binary found and is executable at: ${soxBinPath}`);
} catch (err) {
  console.error(`Sox binary not found or not executable at: ${soxBinPath}`);
  console.error(`Error details: ${err.message}`);
  console.error('Current PATH:', process.env.PATH);
}

// Load environment variables from .env file
dotenv.config();

// Increase the default max listeners to prevent warnings
events.EventEmitter.defaultMaxListeners = 15;

// Imports the Google Cloud client library
// Currently, only v1p1beta1 contains result-end-time
const speech = require('@google-cloud/speech').v1p1beta1;

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('file', {
    alias: 'f',
    description: 'Path to a file to use as context for the AI',
    type: 'string',
  })
  .help()
  .alias('help', 'h')
  .argv;

  // Load environment variables based on environment
  let envConfig;
  if (process.resourcesPath) {
    // When running in packaged app
    envConfig = dotenv.config({ path: path.join(process.resourcesPath, '.env') });
  } else {
    // When running in development
    envConfig = dotenv.config();
  }
  dotenvExpand.expand(envConfig);
  
  // Log environment variable status for debugging
  console.log('Supabase URL available:', !!process.env.SUPABASE_URL);
  console.log('Supabase Anon Key available:', !!process.env.SUPABASE_ANON_KEY);

const GOOGLE_CLOUD_SPEECH_API_KEY = process.env.GOOGLE_CLOUD_SPEECH_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

function getApiKeyCredentials() {
  const sslCreds = grpc.credentials.createSsl();
  const googleAuth = new GoogleAuth();
  const authClient = googleAuth.fromAPIKey(GOOGLE_CLOUD_SPEECH_API_KEY);
  const credentials = grpc.credentials.combineChannelCredentials(
    sslCreds,
    grpc.credentials.createFromGoogleCredential(authClient)
  );
  return credentials;
}

const sslCreds = getApiKeyCredentials();

const client = new speech.SpeechClient({sslCreds});

// AI provider configuration
const AI_PROVIDER = 'openai'; // Set to 'openai' or 'gemini'

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

let chatHistory = [];

// Recording state
let isRecording = false;
let recordingStream = null;
let recordingTimer = null; // Timer for limiting recording duration
// Remove scHelperProcess variable

// Remove useScreenCaptureKit constant

function startRecordingWithSox() {
  // Start the recording with SoX
  recordingStream = recorder
    .record({
      sampleRateHertz: sampleRateHertz,
      threshold: 0, // Silence threshold
      silence: 1000,
      keepSilence: true,
      recordProgram: 'sox',
      options: ['-d', '-b', '16', '-c', '1', '-r', '16000', '-t', 'wav', '-'],
    })
    .stream()
    .on('error', err => {
      // Ensure we always have a valid error message to send to the frontend
      const errorMessage = err && err.message ? err.message : 'Unknown recording error';
      process.send({ type: 'error', data: { message: `Audio recording error: ${errorMessage}` } });
      
      // Log additional debugging information
      console.error('Recording options:', {
        sampleRateHertz,
        recordProgram: 'sox',
        options: ['-d', '-b', '16', '-c', '1', '-r', '16000', '-t', 'wav', '-'],
        PATH: process.env.PATH
      });
      
      isRecording = false;
    });
  
  // Pipe the recording stream to the audio input stream transform
  recordingStream.pipe(audioInputStreamTransform);
  
  // Start the speech recognition stream
  startStream();
}

function startRecording() {
  if (isRecording) return;
  
  isRecording = true;
  audioInput = [];
  lastAudioInput = [];
  restartCounter = 0;
  
  // Always use SoX for recording
  console.log('Using SoX for audio capture');
  startRecordingWithSox();
}

// Stop the recording and speech recognition
function stopRecording() {
  if (!isRecording) return;
  
  // Set recording state to false before stopping streams
  // to prevent error handlers from firing during intentional shutdown
  isRecording = false;
  
  // Clear the recording timer if it exists
  if (recordingTimer) {
    clearTimeout(recordingTimer);
    recordingTimer = null;
  }
  
  try {
    // First stop the speech recognition stream to prevent further writes
    if (recognizeStream) {
      try {
        recognizeStream.removeListener('data', speechCallback);
        recognizeStream.end();
      } catch (streamError) {
        const errorMessage = streamError && streamError.message ? streamError.message : 'unknown error';
        console.error(`Non-fatal recognize stream error: ${errorMessage}`);
      }
      recognizeStream = null;
    }
    
    // Stop the recording stream (SoX) if it's running
    if (recordingStream) {
      // Remove any existing error listeners before destroying the stream
      recordingStream.removeAllListeners('error');
      
      // Add a one-time error handler that just logs but doesn't crash
      recordingStream.once('error', (err) => {
        const errorMessage = err && err.message ? err.message : 'unknown error';
        console.error(`Non-fatal error during stream cleanup: ${errorMessage}`);
      });
      
      // Safely unpipe and destroy the stream
      try {
        recordingStream.unpipe(audioInputStreamTransform);
      } catch (unpipeError) {
        const errorMessage = unpipeError && unpipeError.message ? unpipeError.message : 'unknown error';
        console.error(`Non-fatal unpipe error: ${errorMessage}`);
      }
      
      try {
        recordingStream.destroy();
      } catch (destroyError) {
        const errorMessage = destroyError && destroyError.message ? destroyError.message : 'unknown error';
        console.error(`Non-fatal destroy error: ${errorMessage}`);
      }
      
      recordingStream = null;
    }
    
    // Reset audio input arrays to free memory
    audioInput = [];
    lastAudioInput = [];
    
    // Notify frontend that recording has stopped successfully
    process.send({ type: 'recording-status', data: { isRecording: false } });
    
  } catch (error) {
    // Only log the error, don't send it to the frontend when intentionally stopping
    const errorMessage = error && error.message ? error.message : 'unknown error';
    console.error(`Error during recording cleanup: ${errorMessage}`);
    // Don't send error to frontend for normal stop operations
  }
}

// Pin functionality removed

// Function to retrieve user context from database
async function retrieveUserContext(userId) {
  if (!userId) {
    console.error('[SERVER] Error: User ID not available. Cannot retrieve context.');
    log.error('[SERVER] Error: User ID not available. Cannot retrieve context.');
    return null;
  }

  try {
    // Forward the request to main process which has access to Supabase
    return new Promise((resolve) => {
      // Set up a one-time listener for the response
      const contextResponseHandler = (message) => {
        if (message.type === 'user-context-response') {
          process.removeListener('message', contextResponseHandler);
          resolve(message.data);
        }
      };

      // Add the temporary listener
      process.on('message', contextResponseHandler);

      // Send the request to main process
      process.send({
        type: 'get-user-context',
        data: { userId }
      });

      // Set a timeout to prevent hanging if no response
      setTimeout(() => {
        process.removeListener('message', contextResponseHandler);
        console.warn('[SERVER] Timeout waiting for context response');
        resolve(null);
      }, 5000);
    });
  } catch (error) {
    console.error('[SERVER] Error retrieving user context:', error);
    return null;
  }
}

// Listen for messages from the main process
process.on('message', async (message) => { // Make handler async
  if (message.type === 'start-recording') {
    if (!isRecording) {
      // Plan verification is now handled in main.js
      // Just start the recording process
      startRecording();
      process.send({ 
        type: 'recording-status', 
        data: { isRecording: true } 
      });
    }
  } else if (message.type === 'stop-recording') {
    if (isRecording) {
      // console.log(chalk.yellow('Stopping recording...'));
      stopRecording();
      process.send({ type: 'recording-status', data: { isRecording: false } });
    }
  } else if (message.type === 'retrieve-context') {
    // Handle context retrieval before interview starts
    if (message.data && message.data.userId) {
      console.log('[SERVER] Retrieving context for user:', message.data.userId);
      try {
        const contextData = await retrieveUserContext(message.data.userId);
        
        if (contextData && contextData.content) {
          console.log('[SERVER] Context retrieved successfully');
          
          // Process the context with AI if needed
          let processedContext = contextData.content;
          if (AI_PROVIDER === 'gemini' || AI_PROVIDER === 'openai') {
            try {
              processedContext = await processWithGemini(contextData.content);
              console.log('[SERVER] Context processed with AI');
            } catch (processError) {
              console.error('[SERVER] Error processing context with AI:', processError);
              // Fall back to original content if processing fails
              processedContext = contextData.content;
            }
          }
          
          // Set the retrieved context as the primary context
          fileContext = processedContext;
          extractedContent = processedContext;
          
          process.send({
            type: 'context-update',
            data: {
              message: 'User context retrieved and set',
              contextTitle: contextData.title || 'Saved Context'
            }
          });
        } else {
          console.log('[SERVER] No context found for user');
          process.send({
            type: 'context-update',
            data: { message: 'No saved context found' }
          });
        }
      } catch (error) {
        console.error('[SERVER] Error in context retrieval:', error);
        process.send({
          type: 'error',
          data: { message: 'Failed to retrieve context: ' + (error.message || 'Unknown error') }
        });
      }
    } else {
      console.error('[SERVER] Invalid retrieve-context message: missing userId');
      process.send({
        type: 'error',
        data: { message: 'Invalid context retrieval request: missing user ID' }
      });
    }
  } else if (message.type === 'process-text-context') {
    console.log('Received process-text-context message:', message);
    if (!isRecording && message.data && message.data.text) {
      const textContext = message.data.text;
      console.log('Processing text context...');
      try {
        const processedContext = await processWithGemini(textContext);
        // Set the processed text as the primary context
        fileContext = processedContext; 
        extractedContent = processedContext; // Keep extractedContent consistent
        console.log('Text context processed and set.');
        process.send({ 
          type: 'context-update', 
          data: { message: 'Text context processed and set.' } 
        });
      } catch (error) {
        console.error('Error processing text context with Gemini:', error);
        process.send({ type: 'error', data: { message: 'Failed to process text context.' } });
      }
    }
  } else if (message.type === 'process-file-content') {
    console.log('Received process-file-content message:', message);
    if (!isRecording && message.data) {
        // Handle both direct file path and file content approaches
        if (message.data.filePath) {
            // This is the legacy or direct file path approach
            const filePath = message.data.filePath;
            const fileName = message.data.fileName || path.basename(filePath) || 'uploaded file';
            console.log(`Processing file at path: ${filePath}`);
            
            // Use the unified processContextFile function
            processContextFile(filePath, fileName);
        } else if (message.data.fileName && message.data.fileContent) {
            // This is the legacy approach where file content is sent directly
            // We'll create a temporary file and then process it
            console.log(`Processing file content for: ${message.data.fileName}`);
            try {
                // Create a temporary file
                const tempDir = path.join(os.tmpdir(), 'interm-app');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                const tempFilePath = path.join(tempDir, `${Date.now()}-${message.data.fileName}`);
                const buffer = Buffer.from(new Uint8Array(message.data.fileContent));
                fs.writeFileSync(tempFilePath, buffer);
                
                // Process the temporary file using the unified function
                processContextFile(tempFilePath, message.data.fileName);
            } catch (error) {
                console.error(`Error processing file content for ${message.data.fileName}:`, error);
                process.send({ 
                    type: 'error', 
                    data: { message: `Error processing file: ${error.message}` } 
                });
            }
        } else {
            console.error('Invalid process-file-content message: missing filePath or fileContent');
            process.send({ 
                type: 'error', 
                data: { message: 'Invalid file processing request: missing file path or content' } 
            });
        }
    } else if (isRecording) {
        console.error('Cannot process file while recording is active');
        process.send({ 
            type: 'error', 
            data: { message: 'Cannot process file while recording is active' } 
        });
    } else {
        console.error('Invalid process-file-content message: missing data');
        process.send({ 
            type: 'error', 
            data: { message: 'Invalid file processing request: missing data' } 
        });
    }
  } else if (message.type === 'process-screenshot') {
    if (message.data && message.data.path) {
      // console.log(chalk.green('Processing screenshot...'));
      processScreenshot(message.data.path);
    }
  // Pin functionality removed
  } else if (message.type === 'elaborate') {
    if (message.data && message.data.message) {
      elaborate(message.data.message);
    }
  } else if (message.type === 'get-suggestion') {
    if (message.data && message.data.text) {
      console.log('[SERVER] Received get-suggestion request with text:', message.data.text);
      generateAISuggestion(message.data.text);
    }
  } else if (message.type === 'interview-session') {
    if (message.data) {
      // Log interview session timing data
      console.log('=== INTERVIEW SESSION TIMING ===');
      console.log(`Start Time: ${message.data.startTime}`);
      console.log(`End Time: ${message.data.endTime}`);
      console.log(`Duration: ${message.data.formattedDuration} (${message.data.durationMs}ms)`);
      console.log('===============================');

      const userId = message.data.userId;

      if (!userId) {
        console.error('[SERVER] Error: User ID not available. Cannot save interview session.');
        log.error('[SERVER] Error: User ID not available. Cannot save interview session.');
        return; // Exit if no user ID
      }

      // Forward the interview session data to main process for database insertion
      console.log('[SERVER] Forwarding interview session data to main process');
      log.info('[SERVER] Forwarding interview session data to main process');
      
      // Send the complete session data to main process
      process.send({
        type: 'interview-session-data',
        data: {
          userId: userId,
          startTime: message.data.startTime,
          endTime: message.data.endTime,
          durationMs: message.data.durationMs,
          formattedDuration: message.data.formattedDuration
        }
      });
    }
  } else if (message.type === 'check-plan-status') {
    // Plan status checking is now handled in main.js
    // Just forward the request to main process
    process.send({
      type: 'check-plan-status-request',
      data: message.data
    });
  } else if (message.type === 'ping') {
    // Respond to ping messages to confirm the server is still alive
    process.send({ type: 'pong' });
  }
});

// Function to process text with Gemini
async function processWithGemini(text) {
  console.log('[GEMINI] Processing text for context extraction...');
  if (AI_PROVIDER !== 'gemini') {
      console.warn('[GEMINI] AI_PROVIDER is not set to gemini. Skipping Gemini processing.');
      // Return the original text if not using Gemini, or handle differently
      // For now, just return the original text to avoid breaking flow
      return text; 
  }
  try {
    // Create a prompt that instructs Gemini to extract structured information
    const extractionPrompt = `Extract the key information from the following text in a structured format suitable for use as conversational context. Focus on entities, relationships, and main topics:

${text}`;
    
    // Generate content with the extraction prompt
    const result = await model.generateContent([extractionPrompt]);
    const processedText = result.response.text();
    console.log('[GEMINI] Text processed successfully.');
    return processedText;
  } catch (error) {
    const errorMessage = error?.message || 'unknown error';
    console.error(`[GEMINI] Error processing text: ${errorMessage}`);
    throw new Error(`Gemini processing failed: ${errorMessage}`);
  }
}

// Function to elaborate on a concise response
async function elaborate(text) {
  console.log('[DEBUG] Elaborate function called with text:', text);
  try {
    // Prepare context for inclusion in the system prompt
    let contextData = '';
    if (extractedContent) {
      contextData = extractedContent;
      console.log('[DEBUG] Including extracted content in elaborate function');
    } else if (fileContext) {
      contextData = fileContext;
      console.log('[DEBUG] Including file context in elaborate function');
    }

    // Format the context data for inclusion in the system prompt
    const formattedContext = contextData ? `### Context Information:\n${contextData}\n\n` : "";
    
    // Use the processed context as the primary system prompt if available
    let interviewSystemPrompt = systemPrompt;
    if (contextData) {
      // Combine the formatted context with the system prompt
      interviewSystemPrompt = formattedContext + systemPrompt;
      console.log('[DEBUG] Using processed context as primary system prompt for interview');
    }

    const elaborationPrompt = `Take this concise response: "${text}" and expand it into a detailed technical explanation. Provide specific examples, implementation details, or architectural considerations. Keep the response focused and professional, limited to one paragraph with maximum 5 sentences.`;
    console.log('[DEBUG] Using AI provider:', AI_PROVIDER);

    if (AI_PROVIDER === 'gemini') {
      console.log('[DEBUG] Calling Gemini API');
      
      // Create a system instruction that uses the processed context as the primary system prompt
      const systemInstruction = interviewSystemPrompt + 
        "\nUse the provided context information to craft a detailed response that references specific details from the context when appropriate.";
      
      // Generate content with the enhanced system instruction
      const result = await model.generateContent([
        systemInstruction,
        elaborationPrompt
      ]);
      
      const elaboratedResponse = result.response.text();
      console.log('[DEBUG] Received Gemini response');
      process.send({ type: 'elaboration', data: { text: elaboratedResponse } });
    } else if (AI_PROVIDER === 'openai') {
      console.log('[DEBUG] Calling OpenAI API');
      
      // Prepare enhanced system message with processed context as the primary system prompt
      const systemMessageContent = interviewSystemPrompt + 
        "\n\nUse the provided context information to craft a detailed response that references specific details from the context when appropriate.";
      
      const result = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemMessageContent },
          { role: 'user', content: elaborationPrompt }
        ],
        temperature: 0.3,
      });
      const elaboratedResponse = result.choices[0].message.content;
      console.log('[DEBUG] Received OpenAI response');
      process.send({ type: 'elaboration', data: { text: elaboratedResponse } });
    }
  } catch (error) {
    const errorMessage = error && error.message ? error.message : 'unknown error';
    console.error(`Error generating elaboration: ${errorMessage}`);
    process.send({ type: 'error', data: { message: `Error generating elaboration: ${errorMessage}` } });
  }
}


// Read file content if provided
let fileContext = "";
let fileContentPart = null;
let documentSummary = "";
let extractedContent = "";

async function generateDocumentSummary() {
  if (!argv.file) return;
  
  try {
    const filePath = argv.file;
    const fileExtension = filePath.split('.').pop().toLowerCase();
    
    // Determine MIME type based on file extension
    let mimeType = 'text/plain';
    if (['pdf'].includes(fileExtension)) {
      mimeType = 'application/pdf';
    } else if (['png', 'jpg', 'jpeg', 'gif'].includes(fileExtension)) {
      mimeType = `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`;
    } else if (['docx'].includes(fileExtension)) {
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    
    // For text files, read as UTF-8
    if (mimeType === 'text/plain') {
      const rawFileContent = fs.readFileSync(filePath, 'utf8');
      
      if (AI_PROVIDER === 'gemini') {
        // Extract structured content from the document using Gemini
        const extractResult = await model.generateContent([
          `Read the following document and extract the key information in a structured format that can be used as context for a conversation:\n\n${rawFileContent}`
        ]);
        extractedContent = extractResult.response.text();
        
        // Generate summary for text content
        const result = await model.generateContent([
          `Summarize this document in 3-5 sentences:\n\n${rawFileContent}`
        ]);
        documentSummary = result.response.text();
      } else if (AI_PROVIDER === 'openai') {
        // Extract structured content from the document using OpenAI
        const extractResult = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: `Read the following document and extract the key information in a structured format that can be used as context for a conversation:\n\n${rawFileContent}` }
          ],
          temperature: 0.3,
        });
        extractedContent = extractResult.choices[0].message.content;
        
        // Generate summary for text content
        const result = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: `Summarize this document in 3-5 sentences:\n\n${rawFileContent}` }
          ],
          temperature: 0.3,
        });
        documentSummary = result.choices[0].message.content;
      }
      
      // Use the extracted content instead of raw file content
      fileContext = extractedContent;
      fileContentPart = null; // Ensure fileContentPart is null for text files
    } 
    // For binary files, read as base64 for Gemini multimodal input
    else {
      const fileBuffer = fs.readFileSync(filePath);
      const base64Data = fileBuffer.toString('base64');
      fileContentPart = {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      };
      
      if (AI_PROVIDER === 'gemini') {
        // Extract structured content from the document using Gemini
        const extractResult = await model.generateContent([
          fileContentPart,
          'Read this document and extract the key information in a structured format that can be used as context for a conversation'
        ]);
        extractedContent = extractResult.response.text();
        
        // Generate summary for binary content
        const result = await model.generateContent([
          fileContentPart,
          'Summarize this document in 3-5 sentences'
        ]);
        documentSummary = result.response.text();
      } else if (AI_PROVIDER === 'openai') {
        // For OpenAI, we can't directly process binary files, so we'll need to extract text first

        // For simplicity, we'll just use a placeholder message
        extractedContent = 'Binary document content (OpenAI cannot directly process binary files)';
        documentSummary = 'Binary document (OpenAI cannot directly process binary files)';
      }
      
      // Store the extracted content as text for use in chat
      fileContext = extractedContent;
    }
    
    // Initialize chat with the new context
    await initializeChat();
    
  } catch (error) {
    process.exit(1);
  }
}

// Initialize chat after summary generation
async function initializeChat() {
  if (AI_PROVIDER === 'gemini') {
    // Prepare context for inclusion in the system prompt
    let contextData = '';
    if (extractedContent) {
      contextData = extractedContent;
      console.log('[DEBUG] Using extracted content as primary context for system prompt');
    } else if (fileContext) {
      contextData = fileContext;
      console.log('[DEBUG] Using file context as primary context for system prompt');
    }

    // Format the context data for inclusion in the system prompt
    const formattedContext = contextData ? `### Context Information:\n${contextData}\n\n` : "";

    // Create chat configuration with system instruction that prioritizes the processed context
    const chatConfig = {
      history: chatHistory,
      temprature: 0.2,
      systemInstruction: {
        role: "system",
        parts: [{ 
          text: formattedContext + 
                systemPrompt + 
                (contextData ? "\nUse the provided context information to craft responses that reference specific details from the context when appropriate. Prioritize information from the context when answering questions." : "\nUse the previous conversation responses to maintain a consistent personality and background knowledge throughout the conversation.")
    }]
    }
  };

    // If we have a binary file content, add it to the history instead of system instruction
    if (fileContentPart) {
      chatConfig.history = [
        {
          role: "user",
          parts: [fileContentPart, { text: "Use this document as context for our conversation." }]
        },
        {
          role: "model",
          parts: [{ text: "I'll use this document as context for our conversation." }]
        }
      ];
    } else if (fileContext) {
      // If we have text context, add it to the history
      chatConfig.history = [
        {
          role: "user",
          parts: [{ text: `Here's the document content to use as context:\n\n${fileContext}` }]
        },
        {
          role: "model",
          parts: [{ text: "I'll use this document content as context for our conversation." }]
        }
      ];
    }

    // Initialize the chat with the configuration
    chat = model.startChat(chatConfig);
  } else if (AI_PROVIDER === 'openai') {
    // For OpenAI, we don't need to initialize a chat session in the same way
    // We'll handle messages directly when sending them
    chatHistory = [];
    
    // If we have context, add it to the chat history
    if (fileContext) {
      chatHistory.push(
        { role: "user", content: `Here's the document content to use as context:\n\n${fileContext}` },
        { role: "assistant", content: "I'll use this document content as context for our conversation." }
      );
    }
  }
}

// Initialize chat with default configuration
// Will be properly initialized when context is loaded or by initializeChat()
// Read system prompt from file

// Determine if we're running in a packaged app
let systemPrompt;
try {
  // In development mode, read from the local file
  systemPrompt = fs.readFileSync('system_prompt.txt', 'utf8');
} catch (error) {
  // In production/packaged mode, read from the resources directory
  if (process.resourcesPath) {
    const resourcePath = path.join(process.resourcesPath, 'system_prompt.txt');
    systemPrompt = fs.readFileSync(resourcePath, 'utf8');
  } else {
    console.error('Failed to load system prompt:', error);
    systemPrompt = ''; // Fallback to empty prompt
  }
}

// Initialize chat based on selected AI provider
let chat;
if (AI_PROVIDER === 'gemini') {
  chat = model.startChat({
    history: [],
    systemInstruction: {
      role: "system",
      parts: [{ 
        text: systemPrompt
      }]
    }
  });
}

// Initialize chat properly after startup
initializeChat();

const config = {
  encoding: encoding,
  sampleRateHertz: sampleRateHertz,
  languageCode: languageCode,
  diarizationConfig: {
    enableSpeakerDiarization: true,
    minSpeakerCount: 2,
    maxSpeakerCount: 2
  },
};

const request = {
  config,
  interimResults: true,
};

let recognizeStream = null;
let restartCounter = 0;
let audioInput = [];
let lastAudioInput = [];
let resultEndTime = 0;
let isFinalEndTime = 0;
let finalRequestEndTime = 0;
let newStream = true;
let bridgingOffset = 0;
let lastTranscriptWasFinal = false;
// Initialize global variable to track the last speaker role
global.lastSpeakerRole = 'INTERVIEWER'; // Default first speaker is INTERVIEWER

function startStream() {
  // Don't start a new stream if we're not recording
  if (!isRecording) {
    return;
  }
  
  // Clear current audioInput
  audioInput = [];
  
  // Make sure any existing stream is properly closed before creating a new one
  if (recognizeStream) {
    try {
      recognizeStream.removeListener('data', speechCallback);
      if (!recognizeStream.destroyed && !recognizeStream.writableEnded) {
        recognizeStream.end();
      }
    } catch (err) {
      console.error('Error cleaning up existing stream:', err.message);
    }
    recognizeStream = null;
  }
  
  // Initiate (Reinitiate) a recognize stream
  try {
    recognizeStream = client
      .streamingRecognize(request)
      .on('error', err => {
        if (err.code === 11) {
          console.log('Stream exceeded time limit, restarting...');
          // Don't call restartStream directly to avoid potential race conditions
          // The setTimeout below will handle the restart
        } else {
          console.error('API request error:', err);
        }
      })
      .on('data', speechCallback);
  } catch (err) {
    console.error('Error creating recognize stream:', err.message);
    return;
  }

  // Restart stream when streamingLimit expires
  // Only set the timeout if we're still recording
  if (isRecording) {
    setTimeout(() => {
      if (isRecording) {
        restartStream();
      }
    }, streamingLimit);
  }
}

const speechCallback = stream => {
  // Convert API result end time from seconds + nanoseconds to milliseconds
  resultEndTime =
    stream.results[0].resultEndTime.seconds * 1000 +
    Math.round(stream.results[0].resultEndTime.nanos / 1000000);

  // Calculate correct time based on offset from audio sent twice
  const correctedTime =
    resultEndTime - bridgingOffset + streamingLimit * restartCounter;

  // Fix: Check if process.stdout.clearLine exists before calling it
  if (process.stdout.clearLine) {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
  }
  
  let stdoutText = '';
  let speakerInfo = {};
  
  if (stream.results[0] && stream.results[0].alternatives[0]) {
    const transcript = stream.results[0].alternatives[0].transcript;
    stdoutText = correctedTime + ': ' + transcript;
    
    // Extract speaker diarization information if available
    if (stream.results[0].alternatives[0].words && 
        stream.results[0].alternatives[0].words.length > 0 && 
        stream.results[0].alternatives[0].words[0].speakerTag) {
      
      // Group words by speaker
      const wordsBySpeaker = {};
      
      stream.results[0].alternatives[0].words.forEach(word => {
        const speakerTag = word.speakerTag || 0;
        if (!wordsBySpeaker[speakerTag]) {
          wordsBySpeaker[speakerTag] = [];
        }
        wordsBySpeaker[speakerTag].push(word.word);
      });
      
      // Create speaker information object with raw speaker tags
      const speakers = Object.keys(wordsBySpeaker).map(tag => ({
        speakerTag: parseInt(tag),
        text: wordsBySpeaker[tag].join(' ')
      }));
      
      // Use raw speaker tags instead of role detection
      speakerInfo = {
        hasSpeakerInfo: true,
        speakers: speakers.map(speaker => ({
          ...speaker,
          // Use Speaker 1, Speaker 2, etc. instead of INTERVIEWER/INTERVIEWEE
          role: `Speaker ${speaker.speakerTag}`
        }))
      };
    }
  }

  if (stream.results[0].isFinal) {
    // process.stdout.write(chalk.green(`${stdoutText}\n`));
    
    // Get the finalized transcript
    const userMessage = stream.results[0].alternatives[0].transcript;
    
    // Format speaker information with segments for the frontend
    let formattedSpeakerInfo = {
      hasSpeakerInfo: speakerInfo.hasSpeakerInfo,
      segments: []
    };
    
    // Add segments with speaker roles
    if (speakerInfo.hasSpeakerInfo && speakerInfo.speakers) {
      formattedSpeakerInfo.segments = speakerInfo.speakers.map(speaker => ({
        speakerId: speaker.speakerTag,
        text: speaker.text,
        role: speaker.role || 'UNKNOWN'
      }));
    }
    
    // Send transcript to the Electron frontend via IPC without logging
    process.send({ 
      type: 'transcript', 
      data: { 
        text: userMessage,
        speakerInfo: formattedSpeakerInfo
      } 
    });

    // No longer automatically generating AI suggestions here
    // Suggestions will only be generated when explicitly requested via the 'get-suggestion' IPC call
    
    isFinalEndTime = resultEndTime;
    lastTranscriptWasFinal = true;
  } else {
    // Make sure transcript does not exceed console character length
    if (stdoutText.length > process.stdout.columns) {
      stdoutText =
        stdoutText.substring(0, process.stdout.columns - 4) + '...';
    }
    
    // This section has been moved and updated with speaker info

    lastTranscriptWasFinal = false;
    
    // Send interim transcript to the Electron frontend via IPC with speaker info and roles
    if (stdoutText) {
      // Format speaker information with segments for the frontend
      let formattedSpeakerInfo = {
        hasSpeakerInfo: speakerInfo.hasSpeakerInfo,
        segments: []
      };
      
      // Add segments with speaker roles
      if (speakerInfo.hasSpeakerInfo && speakerInfo.speakers) {
        formattedSpeakerInfo.segments = speakerInfo.speakers.map(speaker => ({
          speakerId: speaker.speakerTag,
          text: speaker.text,
          role: speaker.role || 'UNKNOWN'
        }));
      }
      
      process.send({ 
        type: 'transcript', 
        data: { 
          text: stream.results[0].alternatives[0].transcript,
          speakerInfo: formattedSpeakerInfo,
          isFinal: false
        } 
      });
    }
  }
};

const audioInputStreamTransform = new Writable({
  write(chunk, encoding, next) {
    // Only process chunks if we're actively recording
    if (!isRecording) {
      next();
      return;
    }
    
    if (newStream && lastAudioInput.length !== 0) {
      // Approximate math to calculate time of chunks
      const chunkTime = streamingLimit / lastAudioInput.length;
      if (chunkTime !== 0) {
        if (bridgingOffset < 0) {
          bridgingOffset = 0;
        }
        if (bridgingOffset > finalRequestEndTime) {
          bridgingOffset = finalRequestEndTime;
        }
        const chunksFromMS = Math.floor(
          (finalRequestEndTime - bridgingOffset) / chunkTime
        );
        bridgingOffset = Math.floor(
          (lastAudioInput.length - chunksFromMS) * chunkTime
        );
        
        // Check if recognizeStream is valid before writing to it
        if (recognizeStream && !recognizeStream.destroyed && !recognizeStream.writableEnded) {
          for (let i = chunksFromMS; i < lastAudioInput.length; i++) {
            try {
              recognizeStream.write(lastAudioInput[i]);
            } catch (err) {
              console.error('Error writing to recognizeStream:', err.message);
              break;
            }
          }
        }
      }
      newStream = false;
    }

    // Only store audio input if we're actively recording
    if (isRecording) {
      audioInput.push(chunk);
    }

    // Check if recognizeStream is valid, not destroyed, and not ended before writing to it
    if (recognizeStream && !recognizeStream.destroyed && !recognizeStream.writableEnded) {
      try {
        recognizeStream.write(chunk);
      } catch (err) {
        console.error('Error writing to recognizeStream:', err.message);
      }
    }

    next();
  },

  final() {
    // Check if recognizeStream is valid before ending it
    if (recognizeStream && !recognizeStream.destroyed) {
      try {
        recognizeStream.end();
      } catch (err) {
        console.error('Error ending recognizeStream:', err.message);
      }
    }
  },
});

function restartStream() {
  // Don't restart if we're not recording
  if (!isRecording) {
    return;
  }
  
  if (recognizeStream) {
    try {
      // First remove the listener to prevent callbacks during cleanup
      recognizeStream.removeListener('data', speechCallback);
      // Then safely end the stream if it's not already destroyed or ended
      if (!recognizeStream.destroyed && !recognizeStream.writableEnded) {
        recognizeStream.end();
      }
    } catch (err) {
      console.error('Error during stream restart:', err.message);
    } finally {
      recognizeStream = null;
    }
  }
  if (resultEndTime > 0) {
    finalRequestEndTime = isFinalEndTime;
  }
  resultEndTime = 0;

  lastAudioInput = [];
  lastAudioInput = audioInput;
  
  // Reset audio input for the new stream
  audioInput = [];

  restartCounter++;

  if (!lastTranscriptWasFinal) {
    process.stdout.write('\n');
  }

  newStream = true;

  // Small delay before starting the new stream to ensure proper cleanup
  setTimeout(() => {
    if (isRecording) {
      startStream();
    }
  }, 100);
}
// Process text context provided by the user
async function setTextContext(text) {
  console.log('[SERVER] setTextContext: Processing text context, length:', text.length);
  try {
    // Extract structured content from the text
    console.log('[SERVER] setTextContext: Extracting structured content from text...');
    const extractResult = await model.generateContent([
      `Read the following document and extract the key information in a structured format that can be used as context for a conversation:\n\n${text}`
    ]);
    extractedContent = extractResult.response.text();
    console.log('[SERVER] setTextContext: Extracted content length:', extractedContent.length);
    
    // Generate summary for text content
    console.log('[SERVER] setTextContext: Generating summary...');
    const result = await model.generateContent([
      `Summarize this document in 3-5 sentences:\n\n${text}`
    ]);
    documentSummary = result.response.text();
    console.log('[SERVER] setTextContext: Generated summary:', documentSummary);
    
    // Use the extracted content
    fileContext = extractedContent;
    fileContentPart = null;
    
    // Initialize chat with the new context
    console.log('[SERVER] setTextContext: Initializing chat with new context...');
    await initializeChat();
    
    // Send the summary to the frontend
    console.log('[SERVER] setTextContext: Preparing context-update message with summary...');
    const contextUpdateData = { 
      summary: documentSummary,
      isFile: false
    };
    console.log('[SERVER] setTextContext: Context update data:', JSON.stringify(contextUpdateData));
    
    // Send the message to the main process
    process.send({ 
      type: 'context-update', 
      data: contextUpdateData
    });
    console.log('[SERVER] setTextContext: context-update message sent to main process');
    
    // Send context data to main process for saving to database
    console.log('[SERVER] setTextContext: Sending save-context message to main process...');
    process.send({
      type: 'save-context',
      data: {
        type: 'text',
        title: 'Text Context ' + new Date().toISOString().split('T')[0],
        content: extractedContent,
        metadata: {
          summary: documentSummary,
          rawLength: text.length,
          processedAt: new Date().toISOString()
        }
      }
    });
    console.log('[SERVER] setTextContext: save-context message sent to main process');
    
  } catch (error) {
    // console.error(chalk.red(`Error processing text: ${error.message}`));
    process.send({ type: 'error', data: { message: `Error processing text: ${error.message}` } });
  }
}

// Process a context file uploaded by the user
async function processContextFile(filePath, fileName) {
  // Use the provided fileName or extract it from the path if not provided
  fileName = fileName || path.basename(filePath);
  console.log('[SERVER] processContextFile: Processing file context:', fileName);
  try {
    const fileExtension = filePath.split('.').pop().toLowerCase();
    console.log('[SERVER] processContextFile: File extension:', fileExtension);
    
    // Determine MIME type based on file extension
    let mimeType = 'text/plain';
    if (['pdf'].includes(fileExtension)) {
      mimeType = 'application/pdf';
    } else if (['png', 'jpg', 'jpeg', 'gif'].includes(fileExtension)) {
      mimeType = `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`;
    } else if (['docx'].includes(fileExtension)) {
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    console.log('[SERVER] processContextFile: Using MIME type:', mimeType);
    
    // For text files, read as UTF-8
    if (mimeType === 'text/plain') {
      console.log('[SERVER] processContextFile: Processing as text file...');
      const rawFileContent = fs.readFileSync(filePath, 'utf8');
      console.log('[SERVER] processContextFile: Loaded text file, content length:', rawFileContent.length);
      
      // Extract structured content from the document
      console.log('[SERVER] processContextFile: Extracting structured content...');
      const extractResult = await model.generateContent([
        `Read the following document and extract the key information in a structured format that can be used as context for a conversation:\n\n${rawFileContent}`
      ]);
      extractedContent = extractResult.response.text();
      console.log('[SERVER] processContextFile: Extracted content length:', extractedContent.length);
      
      // Generate summary for text content
      console.log('[SERVER] processContextFile: Generating summary...');
      const result = await model.generateContent([
        `Summarize this document in 3-5 sentences:\n\n${rawFileContent}`
      ]);
      documentSummary = result.response.text();
      console.log('[SERVER] processContextFile: Generated summary:', documentSummary);
      
      // Use the extracted content instead of raw file content
      fileContext = extractedContent;
      fileContentPart = null;
    } 
    // For binary files, read as base64 for Gemini multimodal input
    else {
      console.log('[SERVER] processContextFile: Processing as binary file...');
      const fileBuffer = fs.readFileSync(filePath);
      const base64Data = fileBuffer.toString('base64');
      fileContentPart = {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      };
      console.log('[SERVER] processContextFile: Loaded binary file, size:', fileBuffer.length);
      
      // Extract structured content from the document
      console.log('[SERVER] processContextFile: Extracting structured content from binary...');
      const extractResult = await model.generateContent([
        fileContentPart,
        'Read this document and extract the key information in a structured format that can be used as context for a conversation'
      ]);
      extractedContent = extractResult.response.text();
      console.log('[SERVER] processContextFile: Extracted content length:', extractedContent.length);
      
      // Generate summary for binary content
      console.log('[SERVER] processContextFile: Generating summary from binary...');
      const result = await model.generateContent([
        fileContentPart,
        'Summarize this document in 3-5 sentences'
      ]);
      documentSummary = result.response.text();
      console.log('[SERVER] processContextFile: Generated summary:', documentSummary);
    }
    
    // Initialize chat with the new context
    console.log('[SERVER] processContextFile: Initializing chat with new context...');
    await initializeChat();
    
    // Prepare context update data with detailed logging
    console.log('[SERVER] processContextFile: Preparing context-update message...');
    const contextUpdateData = { 
      message: `File context set: ${fileName}`,
      summary: documentSummary,
      isFile: true
    };
    
    // Log the exact data being sent
    console.log('[SERVER] processContextFile: Context update data structure:', 
      JSON.stringify({
        message: contextUpdateData.message,
        summaryLength: documentSummary ? documentSummary.length : 0,
        isFile: contextUpdateData.isFile
      })
    );
    
    // Send confirmation and summary to the renderer via main process
    console.log('[SERVER] processContextFile: Sending context-update to main process...');
    process.send({ 
      type: 'context-update', 
      data: contextUpdateData
    });
    console.log('[SERVER] processContextFile: context-update message sent to main process');
    
    // Send context data to main process for saving to database
    process.send({
      type: 'save-context',
      data: {
        type: 'file',
        title: fileName,
        content: extractedContent,
        metadata: {
          summary: documentSummary,
          fileType: mimeType,
          fileName: fileName,
          processedAt: new Date().toISOString()
        }
      }
    });
    
  } catch (error) {
    // console.error(chalk.red(`Error processing file: ${error.message}`));
    process.send({ type: 'error', data: { message: `Error processing file: ${error.message}` } });
  }
}

// Start the recording and send the microphone input to the Speech API
async function main() {
  // Generate document summary if file is provided
  await generateDocumentSummary();
  
  // Initialize chat with the document context
  await initializeChat();
  
  // Don't automatically start recording
  console.log('Click Start to begin recording.');
  
  // Notify the frontend that we're ready
  process.send({ type: 'ready', data: { isReady: true } });
}

// Run the main function
main().catch(error => {
  // console.error(chalk.red(`Error: ${error.message}`));
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  // Stop recording if it's running
  if (isRecording) {
    stopRecording();
  }
  console.log('Closing connections and exiting...');
  process.exit(0);
});

// Process a screenshot to extract text using Gemini
async function processScreenshot(screenshotPath) {
  try {
    console.log(`Screenshot path: ${screenshotPath}`);
    
    // Read the screenshot file as base64
    const fileBuffer = fs.readFileSync(screenshotPath);
    const base64Data = fileBuffer.toString('base64');
    
    // Create the image part for Gemini
    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType: 'image/png'
      }
    };
    
    // Extract text from the image using Gemini
    const extractResult = await model.generateContent([
      imagePart,
      'Extract all the text visible in this image. Return only the extracted text without any additional commentary.'
    ], {
      timeout: 30000 // Add timeout to prevent hanging requests
    });
    
    const extractedText = extractResult.response.text();
    
    // Prepare context for inclusion in the system prompt
    let contextData = '';
    if (fileContext) {
      contextData = `\n\n### Context Information:\n${fileContext}`;
      console.log('[SERVER] Including file context in screenshot analysis');
    } else if (extractedContent) {
      contextData = `\n\n### Context Information:\n${extractedContent}`;
      console.log('[SERVER] Including extracted content in screenshot analysis');
    }

    // Generate solution using Gemini with context
    const baseSystemPrompt = `You are a technical problem solver. Analyze the following text and:
1. If it contains code:
   - Identify any bugs or issues
   - Provide corrected code with EXTREMELY CONCISE explanations
   - Format the code properly with syntax highlighting
2. If it contains system architecture or design:
   - Analyze the design patterns and architecture
   - Suggest improvements or best practices
   - Format the documentation in a clear structure
3. If it contains error messages:
   - Diagnose the root cause
   - Provide step-by-step solutions
   - Include code examples if applicable

Format your response in markdown for better readability.`;

    // Add context to system prompt if available
    const enhancedSystemPrompt = baseSystemPrompt + contextData + 
      (contextData ? "\n\nUse the provided context information when relevant to provide more accurate and specific solutions." : "");

    const solutionResult = await model.generateContent([
      enhancedSystemPrompt,
      `Here's the text to analyze:\n${extractedText}`
    ], {
      timeout: 30000 // Add timeout to prevent hanging requests
    });

    const solution = solutionResult.response.text();
    
    // Simplified formatting to reduce processing overhead
    let formattedSolution = solution;
    
    // Only apply minimal formatting when needed
    if (!solution.includes('```') && solution.match(/^[\s\S]*?[{};].*$/m)) {
      // Looks like code, wrap it in a code block
      formattedSolution = '```\n' + solution + '\n```';
    }

    // Send smaller payload to reduce IPC overhead
    process.send({
      type: 'suggestion',
      data: {
        text: formattedSolution
      }
    });
    
    // Send minimal data in screenshot processed event
    process.send({
      type: 'screenshot-processed',
      data: {
        success: true
      }
    });
    
    return extractedText;
  } catch (error) {
    
    // Combine error messages to reduce number of IPC calls
    process.send({
      type: 'error',
      data: {
        message: `Error processing screenshot: ${error.message}`
      }
    });
    
    // Send screenshot processed event with error (combined with suggestion clear)
    process.send({
      type: 'screenshot-processed',
      data: {
        success: false,
        error: error.message,
        clearSuggestion: true
      }
    });
    
    return null;
  }
}

// Function to generate AI suggestions when explicitly requested
async function generateAISuggestion(transcript) {
  console.log('[SERVER] generateAISuggestion called');
  
  // Pin functionality removed
  
  // Check if the transcript is too short to generate a meaningful response
  if (transcript.trim().length < 20) {
    console.log('[SERVER] Skipping AI suggestion - transcript too short');
    process.send({ type: 'error', data: { message: 'Question is too short to generate a meaningful response.' } });
    return;
  }
  
  // Extract and log the most recent interviewer question for debugging
  const lines = transcript.split('\n');
  let mostRecentQuestion = '';
  
  // Scan through the transcript lines in reverse to find the most recent INTERVIEWER question
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('INTERVIEWER:')) {
      mostRecentQuestion = line.substring('INTERVIEWER:'.length).trim();
      break;
    }
  }
  
  console.log('[SERVER] Most recent interviewer question identified:', mostRecentQuestion);
  console.log('[SERVER] Full transcript being sent to AI:', transcript);
  
  // Prepare context for inclusion in the system prompt
  let contextData = '';
  if (extractedContent) {
    contextData = extractedContent;
    console.log('[SERVER] Including extracted content in system prompt');
  } else if (fileContext) {
    contextData = fileContext;
    console.log('[SERVER] Including file context in system prompt');
  }
  
  // Format the context data for inclusion in the system prompt
  const formattedContext = contextData ? `### Context Information:\n${contextData}\n\n` : "";
  
  try {
    if (AI_PROVIDER === 'gemini') {
      console.log('[SERVER] Using Gemini for suggestion');
      
      // Create a new system instruction that prioritizes the processed context
      const systemInstruction = {
        role: "system",
        parts: [{ 
          text: formattedContext + 
                systemPrompt + 
                "\nUse the provided context information to craft responses that reference specific details from the context when appropriate. Prioritize information from the context when answering questions."
        }]
      };
      
      // Initialize a new chat with the updated system instruction
      const contextualChat = model.startChat({
        history: chatHistory,
        systemInstruction: systemInstruction
      });
      
      // Send the message with the updated chat object
      contextualChat.sendMessageStream(transcript)
      .then(async (result) => {
        let fullResponse = '';
        for await (const chunk of result.stream) {
          fullResponse += chunk.text();
        }
        
        // Send AI suggestion to the Electron frontend via IPC
        console.log('[SERVER] Sending suggestion via IPC:', fullResponse);
        process.send({ type: 'suggestion', data: { text: fullResponse } });
        
        // Update chat history
        chatHistory.push(
          { role: 'user', parts: [{ text: transcript }] },
          { role: 'model', parts: [{ text: fullResponse }] }
        );
        
        // Update the global chat object with the new history
        chat = model.startChat({
          history: chatHistory,
          systemInstruction: systemInstruction
        });
      })
      .catch(error => {
        console.error('[SERVER] Error generating Gemini suggestion:', error.message);
        process.send({ type: 'error', data: { message: `Error generating AI suggestion: ${error.message}` } });
      });
    } else if (AI_PROVIDER === 'openai') {
      console.log('[SERVER] Using OpenAI for suggestion');
      (async () => {
        try {
          // Prepare enhanced system message that prioritizes the processed context
          const systemMessageContent = formattedContext + 
                systemPrompt + 
                "\n\nUse the provided context information to craft responses that reference specific details from the context when appropriate. Prioritize information from the context when answering questions.";
          
          console.log('[SERVER] System prompt with context prepared');
          
          const messages = [
            { role: 'system', content: systemMessageContent },
            ...chatHistory,
            { role: 'user', content: transcript }
          ];
          
          console.log('[SERVER] Sending request to OpenAI API');
          // Create a streaming completion
          const stream = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            stream: true,
            temperature: 0.3,
          });
          
          let fullResponse = '';
          
          // Process the stream and send each chunk to the frontend
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              fullResponse += content;
              
              // Send each chunk to the frontend as it arrives
              process.send({ 
                type: 'suggestion-chunk', 
                data: { 
                  text: content,
                  fullText: fullResponse,
                  isFinal: false
                } 
              });
            }
          }
          
          // Send the final complete response
          console.log('[SERVER] Sending final suggestion via IPC:', fullResponse);
          process.send({ 
            type: 'suggestion', 
            data: { 
              text: fullResponse,
              isFinal: true 
            } 
          });
          
          // Update chat history
          chatHistory.push(
            { role: 'user', content: transcript },
            { role: 'assistant', content: fullResponse }
          );
        } catch (error) {
          console.error('[SERVER] Error generating OpenAI suggestion:', error.message);
          process.send({ type: 'error', data: { message: `Error generating AI suggestion: ${error.message}` } });
        }
      })();
    }
  } catch (error) {
    console.error('[SERVER] Unexpected error in generateAISuggestion:', error.message);
    process.send({ type: 'error', data: { message: `Unexpected error generating AI suggestion: ${error.message}` } });
  }
}


  

