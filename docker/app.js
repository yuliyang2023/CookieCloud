const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

const cors = require('cors');
app.use(cors());

const data_dir = path.join(__dirname, 'data');
// make dir if not exist
if (!fs.existsSync(data_dir)) fs.mkdirSync(data_dir);

var multer = require('multer');
var forms = multer({limits: { fieldSize: 100*1024*1024 }});
app.use(forms.array()); 

const bodyParser = require('body-parser')
app.use(bodyParser.json({limit : '50mb' }));  
app.use(bodyParser.urlencoded({ extended: true }));

const api_root = process.env.API_ROOT ? process.env.API_ROOT.trim().replace(/\/+$/, '') : '';
// console.log(api_root, process.env);

app.all(`${api_root}/`, (req, res) => {
    res.send('Hello World!'+`API ROOT = ${api_root}`);
});

// List all uploaded UUIDs without changing browser cookies or server data.
app.get(`${api_root}/records`, (req, res) => {
    try {
        const records = fs.readdirSync(data_dir, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(entry => {
                const uuid = entry.name.slice(0, -5);
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(data_dir, entry.name), 'utf8'));
                    if (typeof data.encrypted !== 'string') throw new Error('Invalid record');
                    return { uuid, encrypted: data.encrypted, crypto_type: data.crypto_type || 'legacy' };
                } catch (error) {
                    return { uuid, error: 'Record cannot be read' };
                }
            });
        res.set('Cache-Control', 'no-store');
        res.json({ records });
    } catch (error) {
        res.status(500).json({ error: 'Failed to list uploaded records' });
    }
});

app.post(`${api_root}/update`, (req, res) => {
    const { encrypted, uuid, crypto_type = 'legacy' } = req.body;
    // none of the fields can be empty
    if (!encrypted || !uuid) {
        res.status(400).send('Bad Request');
        return;
    }

    // save encrypted to uuid file 
    const file_path = path.join(data_dir, path.basename(uuid)+'.json');
    const content = JSON.stringify({encrypted, crypto_type});
    fs.writeFileSync(file_path, content);
    if( fs.readFileSync(file_path) == content )
        res.json({"action":"done"});
    else
        res.json({"action":"error"});
});

app.all(`${api_root}/get/:uuid`, (req, res) => {
    const { uuid } = req.params;
    // none of the fields can be empty
    if (!uuid) {
        res.status(400).send('Bad Request');
        return;
    }
    // get encrypted from uuid file
    const file_path = path.join(data_dir, path.basename(uuid)+'.json');
    if (!fs.existsSync(file_path)) {
        res.status(404).send('Not Found');
        return;
    }
    const data = JSON.parse(fs.readFileSync(file_path));
    if( !data )
    {
        res.status(500).send('Internal Serverless Error');
        return;
    }
    else
    {
        // 如果传递了password，则返回解密后的数据
        if( req.body.password )
        {
            const parsed = cookie_decrypt( uuid, data.encrypted, req.body.password, data.crypto_type || 'legacy' );
            res.json(parsed);
        }else
        {
            res.json(data);
        }
    }
});


app.use(function (err, req, res, next) {
    console.error(err);
    res.status(500).send('Internal Serverless Error');
});


const port = 8088;
app.listen(port, () => {
    console.log(`Server start on http://localhost:${port}${api_root}`);
});

function cookie_decrypt( uuid, encrypted, password, crypto_type = 'legacy' )
{
    if (crypto_type === 'none') return JSON.parse(encrypted);
    const CryptoJS = require('crypto-js');
    const the_key = CryptoJS.MD5(uuid+'-'+password).toString().substring(0,16);
    const decrypted = CryptoJS.AES.decrypt(encrypted, the_key).toString(CryptoJS.enc.Utf8);
    const parsed = JSON.parse(decrypted);
    return parsed;
}
  