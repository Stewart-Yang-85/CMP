
const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJpb3QtY21wLWFwaSIsInN1YiI6ImNtcC1hZG1pbiIsImlhdCI6MTc3Mjc5OTA1OCwiZXhwIjoxNzcyODAyNjU4LCJyb2xlU2NvcGUiOiJwbGF0Zm9ybSIsInJvbGUiOiJwbGF0Zm9ybV9hZG1pbiJ9.bQ_w19OWryTuAC1-AK9W8tvo5YzCF8YP6kVPHEi8IP8';
const enterpriseId = 'a2367c54-fd82-4e07-a013-3d4c345ca7eb';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: `/v1/enterprises/${enterpriseId}/sims:csv?limit=1000&page=1`,
  method: 'GET',
  headers: {
    'accept': 'text/csv',
    'Authorization': `Bearer ${token}`,
    'X-API-Key': 'cmp-admin-key'
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk}`);
  });
  res.on('end', () => {
    console.log('No more data in response.');
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.end();
