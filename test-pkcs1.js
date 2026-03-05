const fs = require('fs');
const { execSync } = require('child_process');

const pem = fs.readFileSync('/Users/mhaynie/Downloads/required-builds-manager.2026-03-04.private-key.pem', 'utf8');

// Replicate the conversion logic from auth.ts
function base64ToArrayBuffer(b64) {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function derEncode(tag, content) {
	const len = content.length;
	let header;
	if (len < 128) {
		header = new Uint8Array([tag, len]);
	} else if (len < 256) {
		header = new Uint8Array([tag, 0x81, len]);
	} else {
		header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
	}
	const result = new Uint8Array(header.length + len);
	result.set(header, 0);
	result.set(content, header.length);
	return result;
}

function pkcs1ToPkcs8(pkcs1) {
	const version = new Uint8Array([0x02, 0x01, 0x00]);
	const algorithmId = new Uint8Array([
		0x30, 0x0d,
		0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
		0x05, 0x00,
	]);
	const octetString = derEncode(0x04, pkcs1);
	const content = new Uint8Array(version.length + algorithmId.length + octetString.length);
	content.set(version, 0);
	content.set(algorithmId, version.length);
	content.set(octetString, version.length + algorithmId.length);
	return derEncode(0x30, content);
}

// Parse PKCS#1 PEM
const b64 = pem
	.replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
	.replace(/-----END RSA PRIVATE KEY-----/, '')
	.replace(/\s/g, '');

const pkcs1 = new Uint8Array(base64ToArrayBuffer(b64));
console.log(`PKCS#1 DER size: ${pkcs1.length} bytes`);

const pkcs8 = pkcs1ToPkcs8(pkcs1);
console.log(`PKCS#8 DER size: ${pkcs8.length} bytes`);

// Write DER to temp file and verify with openssl
const tmpDer = '/tmp/test-pkcs8.der';
fs.writeFileSync(tmpDer, pkcs8);

try {
	const result = execSync(`openssl pkey -inform DER -in ${tmpDer} -noout -text 2>&1`, { encoding: 'utf8' });
	console.log('openssl verification SUCCESS');
	console.log(result.split('\n').slice(0, 3).join('\n'));
} catch (err) {
	console.error('openssl verification FAILED');
	console.error(err.stdout || err.stderr || err.message);
	process.exit(1);
} finally {
	fs.unlinkSync(tmpDer);
}
