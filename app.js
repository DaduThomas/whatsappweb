const { Client, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

var cors = require('cors')
app.use(cors())

var path = require('path')
//app.use(express.static(path.join(__dirname, '/public')));
app.use(express.static(__dirname + '/public'));
app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));
app.use(fileUpload({
  debug: true
}));

FILE_PATH = './public/files/';
const SESSION_FILE_PATH = './whatsapp-session.json';
let sessionCfg;
if (fs.existsSync(SESSION_FILE_PATH)) {
  sessionCfg = require(SESSION_FILE_PATH);
}

app.get('/', (req, res) => {
  res.sendFile('index.html', {
    root: __dirname
  });
});

const client = new Client({
  restartOnAuthFail: true,
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // <- this one doesn't works in Windows
      '--disable-gpu'
    ],
  },
  session: sessionCfg
});

client.on('message', msg => {
  if (msg.body == '!ping') {
    msg.reply('pong');
  } else if (msg.body == 'good morning') {
    msg.reply('selamat pagi');
  } else if (msg.body == '!groups') {
    client.getChats().then(chats => {
      const groups = chats.filter(chat => chat.isGroup);

      if (groups.length == 0) {
        msg.reply('You have no group yet.');
      } else {
        let replyMsg = '*YOUR GROUPS*\n\n';
        groups.forEach((group, i) => {
          replyMsg += `ID: ${group.id._serialized}\nName: ${group.name}\n\n`;
        });
        replyMsg += '_You can use the group id to send a message to the group._'
        msg.reply(replyMsg);
      }
    });
  }
});

client.initialize();

// Socket IO
io.on('connection', function(socket) {
  socket.emit('message', 'Connecting...');

  client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      socket.emit('qr', url);
      socket.emit('message', 'QR Code received, scan please!');
    });
  });

  client.on('ready', () => {
    socket.emit('ready', 'Whatsapp is ready!');
    socket.emit('message', 'Whatsapp is ready!');
  });

  client.on('authenticated', (session) => {
    socket.emit('authenticated', 'Whatsapp is authenticated!');
    socket.emit('message', 'Whatsapp is authenticated!');
    console.log('AUTHENTICATED', session);
    sessionCfg = session;
    fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function(err) {
      if (err) {
        console.log('>>>> ERR');
        console.error(err);
      }
      else{
        console.log('>>>> Success');
        //socket.emit('redirect', 'https://www.geeksforgeeks.org');

      }
    });
  });

  client.on('auth_failure', function(session) {
    socket.emit('message', 'Auth failure, restarting...');
  });

  client.on('disconnected', (reason) => {
    console.log("dis>>>>>>>>>>>");
    socket.emit('message', 'Whatsapp is disconnected!');
    fs.unlinkSync(SESSION_FILE_PATH, function(err) {
        if(err) return console.log(err);
        console.log('Session file deleted!');
    });
    client.destroy();
    client.initialize();
  });
});


const checkRegisteredNumber = async function(number) {
  const isRegistered = await client.isRegisteredUser(number);
  return isRegistered;
}

// Send message
app.post('/send-message', [
  body('number').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }

  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  const isRegisteredNumber = await checkRegisteredNumber(number);
  // const str = 'Values: The number is not registered';
  // const m=str.concat(42, '  ', null);
  console.log(number);
  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered>>'
    });
  }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

// Send media
app.post('/send-media', async (req, res) => {
  const number = phoneNumberFormatter(req.body.number);
  const caption = req.body.caption;
  const fileUrl = req.body.file;

  // const media = MessageMedia.fromFilePath('./image-example.png');
  // const file = req.files.file;
  // const media = new MessageMedia(file.mimetype, file.data.toString('base64'), file.name);
  let mimetype;
  const attachment = await axios.get(fileUrl, {
    responseType: 'arraybuffer'
  }).then(response => {
    mimetype = response.headers['content-type'];
    return response.data.toString('base64');
  });

  const media = new MessageMedia(mimetype, attachment, 'Media');

  client.sendMessage(number, media, {
    caption: caption
  }).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

const findGroupByName = async function(name) {
  const group = await client.getChats().then(chats => {
    return chats.find(chat => 
      chat.isGroup && chat.name.toLowerCase() == name.toLowerCase()
    );
  });
  return group;
}


// Send message to group
// You can use chatID or group name, yea!
app.post('/send-group-message', [
  body('id').custom((value, { req }) => {
    if (!value && !req.body.name) {
      throw new Error('Invalid value, you can use `id` or `name`');
    }
    return true;
  }),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }

  let chatId = req.body.id;
  const groupName = req.body.name;
  const message = req.body.message;

  // Find the group by name
  if (!chatId) {
    const group = await findGroupByName(groupName);
    if (!group) {
      return res.status(422).json({
        status: false,
        message: 'No group found with name: ' + groupName
      });
    }
    chatId = group.id._serialized;
  }

  client.sendMessage(chatId, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

// Clearing message on spesific chat
app.post('/clear-message', [
  body('number').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }

  const number = phoneNumberFormatter(req.body.number);

  const isRegisteredNumber = await checkRegisteredNumber(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  const chat = await client.getChatById(number);
  
  chat.clearMessages().then(status => {
    res.status(200).json({
      status: true,
      response: status
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  })
});


app.post('/save-case', [
  body('fileName').notEmpty(),
  body('data').notEmpty()
], async (req, res) => {
  CASE_FILE_PATH=FILE_PATH+req.body.fileName+".json";
console.log(CASE_FILE_PATH);

console.log("3>>>><<<"+JSON.stringify(req.body.data));
  fileData = require(CASE_FILE_PATH);
  fileData.push(JSON.parse(req.body.data)); 
  console.log("5>>>><<<"+JSON.stringify(fileData));

  console.log("f>>>"+req.body.fileName);

  fs.writeFile(CASE_FILE_PATH, JSON.stringify(fileData), function(err) {
    if (err) {
      res.status(500).json({
        status: false,
        response: err
      });
    }
    else{
      res.status(200).json({
        status: true,
        response: 'success'
      });
    }
  });
});

app.post('/read-case', [
  body('fileName').notEmpty()
], async (req, res) => {
  let caseData;
  console.log("f>>>"+req.body.fileName);
  CASE_FILE_PATH=FILE_PATH+req.body.fileName+".json";
  if (fs.existsSync(CASE_FILE_PATH)) {
      caseData = require(CASE_FILE_PATH);
      console.log("f CASE_FILE_PATH>>>"+JSON.stringify(caseData));
      res.status(200).json({
        status: true,
        response: caseData
      });
  }
  else{
    res.status(500).json({
      status: false,
      response: 'File Not Found '+CASE_FILE_PATH
    });  
  }

  
  // fs.writeFile(CASE_FILE_PATH, JSON.stringify(caseData), function(err) {
  //   if (err) {
  //     res.status(500).json({
  //       status: false,
  //       response: err
  //     });
  //   }
  //   else{
  //     res.status(200).json({
  //       status: true,
  //       response: response
  //     });
  //   }
  // });
});

app.post('/delete-case', [
  body('fileName').notEmpty(),
  body('index').notEmpty()
], async (req, res) => {
  let caseData;
  console.log("f>>>"+req.body.fileName);
  console.log("f index>>>"+req.body.index);
  CASE_FILE_PATH=FILE_PATH+req.body.fileName+".json";

  if (fs.existsSync(CASE_FILE_PATH)) {
      caseData = require(CASE_FILE_PATH);
      //caseData.spilce(req.body.index,1);
      

      caseData.splice(req.body.index,1);  
      console.log("f CASE_FILE_PATH>>>"+JSON.stringify(caseData));
      fs.writeFile(CASE_FILE_PATH, JSON.stringify(caseData), function(err) {
        if (err) {
          res.status(500).json({
            status: false,
            response: err
          });
        }
        else{
          res.status(200).json({
            status: true,
            response: 'success'
          });
        }
      });
  }
  else{
    res.status(500).json({
      status: false,
      response: 'File Not Found '+CASE_FILE_PATH
    });  
  }
});

server.listen(port, function() {
  console.log('App running on *: ' + port);
});
