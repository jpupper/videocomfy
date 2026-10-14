#!/usr/bin/env node
// Debug script - test storyboard generation
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:5634');
const TIMEOUT = 300000; // 5 min

console.log('Connecting to ws://localhost:5634...');
console.log('Timeout Set:', TIMEOUT, 'ms');

var timeout = setTimeout(function() {
  console.log('TIMEOUT reached - no result after', TIMEOUT/1000, 'seconds');
  console.log('Closing WebSocket');
  ws.close();
  process.exit(1);
}, TIMEOUT);

ws.on('open', function() {
  console.log('Connected! Sending storyboard request...');
  var msg = JSON.stringify({
    type: 'generarStoryboard',
    prompt: 'A premium wine bottle and a glass of red wine on a rustic wooden table, product photography',
    params: { storyboardSteps: 20, videoWidth: 768, videoHeight: 768 },
    storyboardIndex: 0,
    batchId: 'debug-test'
  });
  console.log('Sending:', msg.substring(0, 100) + '...');
  ws.send(msg);
});

ws.on('message', function(data) {
  var text = data.toString();
  console.log('Message received:', text.substring(0, 200));
  var msg;
  try { msg = JSON.parse(text); } catch(e) { console.log('Parse error:', e.message); return; }
  console.log('Type:', msg.type);
  console.log('Has filename:', !!msg.filename);
  console.log('Has file:', !!msg.file);
  console.log('Full keys:', Object.keys(msg).join(', '));

  if (msg.filename || msg.file || msg.type === 'result' || msg.type === 'complete') {
    clearTimeout(timeout);
    console.log('\n=== GOT RESULT ===');
    console.log(JSON.stringify(msg, null, 2));
    ws.close();
    process.exit(0);
  }
});

ws.on('error', function(err) {
  console.log('WebSocket Error:', err.message);
});

ws.on('close', function(code, reason) {
  console.log('WebSocket closed:', code, reason ? reason.toString() : '');
});
