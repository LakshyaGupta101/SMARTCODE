const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/monaco-editor', express.static(path.join(__dirname, 'node_modules/monaco-editor')));

// In-memory storage
const sharedCodes = new Map();
const pairSessions = new Map();
const studyGroups = new Map();
const globalStudyGroups = new Map(); // Global list of all study groups
const userSessions = new Map(); // Map of userId -> sessionId for video calls
const videoCalls = new Map(); // Map of call sessions

// Utility function to create temp files
const createTempFile = (code, language) => {
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const extensions = {
    python: '.py',
    javascript: '.js',
    java: '.java',
    cpp: '.cpp'
  };

  const fileName = `temp_${Date.now()}${extensions[language] || '.txt'}`;
  const filePath = path.join(tempDir, fileName);
  
  // For Java, we need to use the class name
  if (language === 'java') {
    const className = extractJavaClassName(code) || 'Main';
    const javaFileName = `${className}.java`;
    const javaFilePath = path.join(tempDir, javaFileName);
    fs.writeFileSync(javaFilePath, code);
    return { filePath: javaFilePath, fileName: javaFileName, className };
  }
  
  fs.writeFileSync(filePath, code);
  return { filePath, fileName };
};

// Extract Java class name from code
const extractJavaClassName = (code) => {
  const match = code.match(/public\s+class\s+(\w+)/);
  return match ? match[1] : 'Main';
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/share/:codeId', (req, res) => {
  const codeId = req.params.codeId;
  if (sharedCodes.has(codeId)) {
    res.sendFile(path.join(__dirname, 'public', 'share.html'));
  } else {
    res.status(404).send('Shared code not found');
  }
});

app.get('/pair/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

app.get('/study/:groupId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'study.html'));
});

app.get('/groups', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'groups.html'));
});

// API route to get all active study groups
app.get('/api/groups', (req, res) => {
  const groups = Array.from(globalStudyGroups.entries()).map(([id, group]) => ({
    id,
    name: group.name,
    userCount: group.users.length,
    createdAt: group.createdAt
  }));
  res.json(groups);
});

// API route to create a new study group
app.post('/api/groups', (req, res) => {
  const { name } = req.body;
  const groupId = uuidv4().substr(0, 8);
  
  const newGroup = {
    id: groupId,
    name: name || `Study Group ${groupId}`,
    createdAt: new Date(),
    users: [],
    code: '// Welcome to the study group!\n// Collaborate and learn together...',
    language: 'javascript',
    messages: [],
    questions: []
  };
  
  globalStudyGroups.set(groupId, newGroup);
  studyGroups.set(groupId, newGroup);
  
  res.json({ groupId, name: newGroup.name });
});

// API Routes
app.post('/api/run', (req, res) => {
  const { code, language } = req.body;
  
  if (!code || !language) {
    return res.status(400).json({ error: 'Code and language are required' });
  }

  const { filePath, fileName, className } = createTempFile(code, language);
  
  const commands = {
    python: process.platform === "win32"
      ? `python "${filePath}"`
      : `python3 "${filePath}"`,
    javascript: `node "${filePath}"`,
    java: `cd "${path.dirname(filePath)}" && javac "${fileName}" && java ${className}`,
    cpp: process.platform === "win32"
      ? `cd "${path.dirname(filePath)}" && g++ "${fileName}" -o output.exe && output.exe`
      : `cd "${path.dirname(filePath)}" && g++ "${fileName}" -o output && ./output`
  };

  const command = commands[language];
  if (!command) {
    return res.status(400).json({ error: 'Unsupported language' });
  }

  exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
    // Clean up temp file
    try {
      fs.unlinkSync(filePath);
      if (language === 'cpp') {
        const outputPath = path.join(path.dirname(filePath), 'output');
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      }
      if (language === 'java') {
        const classPath = path.join(path.dirname(filePath), `${className}.class`);
        if (fs.existsSync(classPath)) {
          fs.unlinkSync(classPath);
        }
      }
    } catch (e) {
      console.log('Error cleaning up temp file:', e.message);
    }

    if (error) {
      return res.json({
        success: false,
        output: stderr || error.message,
        error: true
      });
    }

    res.json({
      success: true,
      output: stdout || 'Program executed successfully (no output)',
      error: false
    });
  });
});

app.post('/api/share', (req, res) => {
  const { code, language, title } = req.body;
  const codeId = uuidv4();
  
  sharedCodes.set(codeId, {
    code,
    language,
    title: title || 'Untitled',
    createdAt: new Date()
  });

  res.json({ codeId, shareUrl: `/share/${codeId}` });
});

app.get('/api/share/:codeId', (req, res) => {
  const codeId = req.params.codeId;
  const sharedCode = sharedCodes.get(codeId);
  
  if (sharedCode) {
    res.json(sharedCode);
  } else {
    res.status(404).json({ error: 'Shared code not found' });
  }
});

// Minimal code analysis endpoint (syntax check only)
app.post('/api/analyze', async (req, res) => {
  const { code, language } = req.body;
  if (!code || !language) {
    return res.status(400).json({ error: 'Code and language are required' });
  }
  const { filePath } = createTempFile(code, language);
  let command;
  if (language === 'javascript') {
    command = `node "${filePath}"`;
  } else if (language === 'python') {
    command = `python "${filePath}"`;
  } else {
    fs.unlinkSync(filePath);
    return res.status(400).json({ error: 'Analysis only supported for JavaScript and Python' });
  }
  console.log('Analyzing file:', filePath, 'with command:', command);
  try {
    const fileContents = fs.readFileSync(filePath, 'utf8');
    console.log('File contents for analysis:', fileContents);
  } catch (e) {
    console.log('Could not read temp file:', e.message);
  }
  exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(filePath); } catch (e) {}
    if (stderr && stderr.trim()) {
      let errMsg = stderr;
      let lineMatch = errMsg.match(/(line (\d+))/i) || errMsg.match(/:(\d+):/);
      let lineInfo = lineMatch ? ` (line ${lineMatch[2] || lineMatch[1]})` : '';
      return res.json({ success: false, output: `Error${lineInfo}: ${errMsg}` });
    }
    if (error) {
      let errMsg = error.message;
      let lineMatch = errMsg.match(/(line (\d+))/i) || errMsg.match(/:(\d+):/);
      let lineInfo = lineMatch ? ` (line ${lineMatch[2] || lineMatch[1]})` : '';
      return res.json({ success: false, output: `Error${lineInfo}: ${errMsg}` });
    }
    res.json({ success: true, output: 'Code is valid!' });
  });
});

// Socket.io handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Pair programming
  socket.on('join-pair-session', (sessionId) => {
    socket.join(sessionId);
    
    if (!pairSessions.has(sessionId)) {
      pairSessions.set(sessionId, {
        code: '// Welcome to pair programming!\n// Start coding together...',
        language: 'javascript',
        users: []
      });
    }

    const session = pairSessions.get(sessionId);
    session.users.push(socket.id);
    
    socket.emit('session-state', {
      code: session.code,
      language: session.language
    });

    socket.to(sessionId).emit('user-joined', socket.id);
  });

  socket.on('code-change', (data) => {
    const { sessionId, code, language } = data;
    
    if (pairSessions.has(sessionId)) {
      const session = pairSessions.get(sessionId);
      session.code = code;
      if (language) session.language = language;
      
      socket.to(sessionId).emit('code-update', { code, language });
    }
  });

  // Study groups
  socket.on('join-study-group', (groupId) => {
    socket.join(groupId);
    
    // Check if group exists in global list first
    let group;
    if (globalStudyGroups.has(groupId)) {
      group = globalStudyGroups.get(groupId);
      if (!studyGroups.has(groupId)) {
        studyGroups.set(groupId, group);
      }
    } else {
      // Create new group if it doesn't exist
      group = {
        id: groupId,
        name: `Study Group ${groupId}`,
        createdAt: new Date(),
        code: '// Welcome to the study group!\n// Collaborate and learn together...',
        language: 'javascript',
        users: [],
        messages: [],
        questions: []
      };
      globalStudyGroups.set(groupId, group);
      studyGroups.set(groupId, group);
    }

    group.users.push({ id: socket.id, name: `User${group.users.length + 1}` });
    
    socket.emit('group-state', {
      code: group.code,
      language: group.language,
      messages: group.messages,
      questions: group.questions,
      users: group.users,
      groupName: group.name
    });

    socket.to(groupId).emit('user-joined-group', {
      id: socket.id,
      name: `User${group.users.length}`
    });
    
    // Update global group user count
    io.emit('group-updated', {
      id: groupId,
      userCount: group.users.length
    });
  });

  socket.on('group-code-change', (data) => {
    const { groupId, code, language } = data;
    
    if (studyGroups.has(groupId)) {
      const group = studyGroups.get(groupId);
      group.code = code;
      if (language) group.language = language;
      
      socket.to(groupId).emit('group-code-update', { code, language });
    }
  });

  socket.on('send-message', (data) => {
    const { groupId, message, username } = data;
    
    if (studyGroups.has(groupId)) {
      const group = studyGroups.get(groupId);
      const msgData = {
        id: uuidv4(),
        text: message,
        username: username || 'Anonymous',
        timestamp: new Date()
      };
      
      group.messages.push(msgData);
      io.to(groupId).emit('new-message', msgData);
    }
  });

  socket.on('add-question', (data) => {
    const { groupId, question, username } = data;
    
    if (studyGroups.has(groupId)) {
      const group = studyGroups.get(groupId);
      const questionData = {
        id: uuidv4(),
        text: question,
        username: username || 'Anonymous',
        timestamp: new Date()
      };
      
      group.questions.push(questionData);
      io.to(groupId).emit('new-question', questionData);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Clean up user from sessions
    pairSessions.forEach((session, sessionId) => {
      const userIndex = session.users.indexOf(socket.id);
      if (userIndex > -1) {
        session.users.splice(userIndex, 1);
        socket.to(sessionId).emit('user-left', socket.id);
      }
    });

    studyGroups.forEach((group, groupId) => {
      const userIndex = group.users.findIndex(user => user.id === socket.id);
      if (userIndex > -1) {
        const user = group.users[userIndex];
        group.users.splice(userIndex, 1);
        socket.to(groupId).emit('user-left-group', user);
        
        // Update global group user count
        io.emit('group-updated', {
          id: groupId,
          userCount: group.users.length
        });
        
        // Remove group from global list if empty
        if (group.users.length === 0) {
          globalStudyGroups.delete(groupId);
          studyGroups.delete(groupId);
          io.emit('group-removed', groupId);
        }
      }
    });
  });

  // Video call handling
  socket.on('initiate-call', (data) => {
    const { recipientId } = data;
    const caller = socket.id;
    
    // Store the call session
    const callId = `${caller}-${recipientId}`;
    videoCalls.set(callId, {
      caller: caller,
      recipient: recipientId,
      status: 'pending'
    });
    
    // Notify recipient of incoming call
    io.to(recipientId).emit('call-initiated', { callerId: caller });
  });

  socket.on('call-answered', (data) => {
    const caller = data.callerId;
    const answerer = socket.id;
    
    // Notify caller that call was answered
    io.to(caller).emit('call-answered', { answererId: answerer });
  });

  socket.on('offer', (data) => {
    const { offer } = data;
    const sender = socket.id;
    
    // Broadcast offer to all connected clients (they will check if it's for them)
    socket.broadcast.emit('offer', { offer, senderId: sender });
  });

  socket.on('answer', (data) => {
    const { answer } = data;
    const sender = socket.id;
    
    // Broadcast answer to all connected clients
    socket.broadcast.emit('answer', { answer, senderId: sender });
  });

  socket.on('ice-candidate', (data) => {
    const { candidate } = data;
    const sender = socket.id;
    
    // Broadcast ICE candidate to all connected clients
    socket.broadcast.emit('ice-candidate', { candidate, senderId: sender });
  });

  socket.on('call-rejected', (data) => {
    const { callerId } = data;
    io.to(callerId).emit('call-rejected', { message: 'Call was rejected' });
  });

  socket.on('end-call', (data) => {
    const caller = socket.id;
    
    // Notify all clients that call has ended
    socket.broadcast.emit('call-ended', { callerId: caller });
    
    // Clean up video call data
    const callId = Array.from(videoCalls.keys()).find(id => 
      id.includes(caller)
    );
    if (callId) {
      videoCalls.delete(callId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Smart Coding Environment running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});