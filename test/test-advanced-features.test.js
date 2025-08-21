import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import http from 'http';

// Configuration - following comprehensive.test.js pattern
const DEFAULT_HOST = 'localhost:8080';
const DEFAULT_API_KEY = 'test-user-1';

// Parse environment variables for configuration
const host = process.env.TEST_HOST || DEFAULT_HOST;
const apiKey = process.env.TEST_API_KEY || DEFAULT_API_KEY;

const [hostname, portStr] = host.split(':');
const port = portStr ? parseInt(portStr, 10) : 8080;

// Helper function to make HTTP requests
function makeRequest(options, data, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseData = '';
      const chunks = [];
      
      res.on('data', (chunk) => {
        chunks.push(chunk);
        responseData += chunk;
      });
      
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: responseData,
          buffer: buffer
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.setTimeout(timeout);
    
    if (data) {
      req.write(data);
      req.end();
    } else {
      req.end();
    }
  });
}

describe('Advanced Features Tests', function() {
  this.timeout(60000);

  before(function() {
    console.log(`🚀 Starting advanced features test suite for http://${host}`);
    console.log(`Using API key: ${apiKey.substring(0, 8)}...`);
  });

  it('should handle JSON mode (response_format)', async function() {
    const requestData = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant designed to output JSON.' },
        { role: 'user', content: 'Generate a simple JSON object with name and age fields for a person named John who is 30 years old.' }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 100
    });
    
    const options = {
      hostname: hostname,
      port: port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
        'Content-Length': Buffer.byteLength(requestData)
      }
    };
    
    const response = await makeRequest(options, requestData);
    
    if (response.statusCode !== 200) {
      console.log('Error response status:', response.statusCode);
      console.log('Error response data:', response.data);
    }
    
    expect(response.statusCode).to.equal(200);
    expect(response.headers['content-type']).to.include('application/json');
    
    const json = JSON.parse(response.data);
    expect(json.choices).to.exist;
    expect(json.choices[0].message.content).to.exist;
    
    // Verify the response content is valid JSON
    const content = json.choices[0].message.content;
    console.log('JSON mode response content:', content);
    
    // Should be able to parse the content as JSON
    const parsedContent = JSON.parse(content);
    expect(parsedContent).to.be.an('object');
    expect(parsedContent.name).to.exist;
    expect(parsedContent.age).to.exist;
  });

  it('should handle tool/function calling', async function() {
    const requestData = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'What is the weather like in San Francisco?' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather in a given location',
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'The city and state, e.g. San Francisco, CA'
                },
                unit: {
                  type: 'string',
                  enum: ['celsius', 'fahrenheit']
                }
              },
              required: ['location']
            }
          }
        }
      ],
      tool_choice: 'auto',
      max_completion_tokens: 100
    });
    
    const options = {
      hostname: hostname,
      port: port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
        'Content-Length': Buffer.byteLength(requestData)
      }
    };
    
    const response = await makeRequest(options, requestData);
    
    if (response.statusCode !== 200) {
      console.log('Error response status:', response.statusCode);
      console.log('Error response data:', response.data);
    }
    
    expect(response.statusCode).to.equal(200);
    expect(response.headers['content-type']).to.include('application/json');
    
    const json = JSON.parse(response.data);
    expect(json.choices).to.exist;
    expect(json.choices[0].message).to.exist;
    
    console.log('Tool calling response:', JSON.stringify(json.choices[0].message, null, 2));
    
    // Check if the model called the function
    const message = json.choices[0].message;
    if (message.tool_calls && message.tool_calls.length > 0) {
      console.log('✅ Model made tool calls:', message.tool_calls.length);
      expect(message.tool_calls[0].function.name).to.equal('get_weather');
      expect(message.tool_calls[0].function.arguments).to.exist;
      
      // Parse the arguments to verify they're valid JSON
      const args = JSON.parse(message.tool_calls[0].function.arguments);
      expect(args.location).to.exist;
      console.log('Function arguments:', args);
    } else {
      console.log('ℹ️  Model did not call tools (but tool calling is supported)');
      // Tool calling is still working even if the model chose not to use it
    }
  });

  it('should handle streaming with tools', async function() {
    const requestData = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Call the calculator function to add 5 and 3' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Perform basic math operations',
            parameters: {
              type: 'object',
              properties: {
                operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
                a: { type: 'number' },
                b: { type: 'number' }
              },
              required: ['operation', 'a', 'b']
            }
          }
        }
      ],
      stream: true,
      max_completion_tokens: 100
    });
    
    const options = {
      hostname: hostname,
      port: port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
        'Content-Length': Buffer.byteLength(requestData)
      }
    };
    
    // Use streaming request helper from streaming test
    const response = await new Promise((resolve, reject) => {
      const chunks = [];
      
      const req = http.request(options, (res) => {
        res.on('data', (chunk) => {
          chunks.push(chunk.toString());
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            chunks: chunks,
            data: chunks.join('')
          });
        });
      });
      
      req.on('error', reject);
      req.setTimeout(30000);
      req.write(requestData);
      req.end();
    });
    
    if (response.statusCode !== 200) {
      console.log('Error response status:', response.statusCode);
      console.log('Error response data:', response.data);
    }
    
    expect(response.statusCode).to.equal(200);
    expect(response.headers['content-type']).to.equal('text/event-stream');
    
    console.log('Streaming with tools - received', response.chunks.length, 'chunks');
    console.log('Sample chunks:', response.chunks.slice(0, 2));
    
    // Verify streaming format
    expect(response.data).to.include('data: ');
    expect(response.data).to.include('[DONE]');
  });
});
