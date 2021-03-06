const crypto = require('crypto');
const http = require('http');

var AES = function (host, username, password, connection) {
    this._host = host;
    this._username = username;
    this._password = password;
    this._connection = connection;
    this._hmac_hash = '';

    this._public_key = '';
    this._iv = crypto.randomBytes(16);
    this._key = crypto.createHash('sha256').update(crypto.randomBytes(16).toString('hex')).digest();
    this._session_key;

    this._current_salt = this._get_salt();
    this._salt_usage_count = 0;
    this._max_salt_usage = 2;
};

AES.prototype.__proto__ = require('events').EventEmitter.prototype;

AES.prototype.authorize = function() {
    this._get_public_key();
};

AES.prototype.prepare_command = function(uuidAction, command) {
    var salt_part = 'salt/'+(this._current_salt);
    this._salt_usage_count++;
    if (this._salt_usage_count >= this._max_salt_usage){
        salt_part = 'nextSalt/'+(this._current_salt)+'/';
        this._current_salt = this._get_salt();
        this._salt_usage_count = 0;
        salt_part += (this._current_salt);
    }
    var prefix = 'jdev/sps/ios/'+this._hmac_hash+'/';
    var enc_part = this._cipher(salt_part + '/' + prefix + uuidAction + '/' + command, 'base64');

    return 'jdev/sys/enc/'+encodeURIComponent(enc_part);
};

AES.prototype.get_command_chain = function() {
    var that = this;
    return [
        {
            'control': /^jdev\/sys\/keyexchange\//,
            'callback': function(loxone_message) {
                var key = new Buffer(that._decipher(loxone_message.value), 'hex').toString('utf8');
                var hmac = crypto.createHmac('sha1', key);
                var hmac_hash = hmac.update(that._username+':'+that._password).digest('hex');
                that._hmac_hash = hmac_hash;
                var enc_data = that._cipher(that._hmac_hash+'/'+that._username, 'base64');
                that._connection.send('authenticateEnc/'+enc_data);
            }
        },
        {
            'control': /^authenticateEnc\//,
            'callback': function(loxone_message) {
                if (loxone_message.code === '200'){
                    that.emit('authorized');
                }else{
                    that.emit('auth_failed', loxone_message);
                }
            },
        }
    ];
};

AES.prototype._get_public_key = function() {
    var that = this;

    http.get('http://'+this._host+'/jdev/sys/getPublicKey', (res) => {
        res.on('data', (chunk) => {
            that._parse_public_key(chunk);
            that._generate_session_key();
        });
        res.resume();
    }).on('error', (e) => {
        that.emit('auth_failed', e.message);
    });
};

AES.prototype._parse_public_key = function(content) {
    var data = JSON.parse(content);
    var key = data.LL.value.replace(/CERTIFICATE/g, 'PUBLIC KEY');
    key = key.replace(/^(-+BEGIN PUBLIC KEY-+)(\w)/, '$1\n$2');
    key = key.replace(/(\w)(-+END PUBLIC KEY-+)$/, '$1\n$2');
    this._public_key = {
        'key': key,
        'padding': crypto.constants.RSA_PKCS1_PADDING
    };
};

AES.prototype._generate_session_key = function() {
    this._session_key = crypto.publicEncrypt(this._public_key, Buffer.from(this._key.toString('hex')+':'+this._iv.toString('hex')));
    this._connection.send('jdev/sys/keyexchange/'+this._session_key.toString('base64'));
};

AES.prototype._decipher = function(enc_data) {
    var decipher = crypto.createDecipheriv('aes-256-cbc', this._key, this._iv);
    decipher.setAutoPadding(false);
    var data = decipher.update(enc_data,'base64','utf-8');
    data += decipher.final('utf-8');
    return data;
};

AES.prototype._cipher = function(data, out_enc) {
    var cipher = crypto.createCipheriv('aes-256-cbc', this._key, this._iv);
    var enc_data = cipher.update(data + "\0",'utf-8', out_enc);
    enc_data += cipher.final(out_enc);
    return enc_data;
};

AES.prototype._get_salt = function() {
    return encodeURIComponent(crypto.randomBytes(32).toString('base64'));
};

module.exports = AES;
