var _ = require('lodash');
var pkgJson = require('../package.json');
var homieVersion = '3.0.1';
var homieImplName = 'nodejs:' + pkgJson.name;
var homieImplVersion = pkgJson.version;
var mqtt = require('mqtt');
var HomieNode = require('./homieNode');
var EventEmitter = require('events').EventEmitter;

const DEFAULT_CONFIG = {
  "name": "",
  "device_id": "unknown",
  "mqtt": {
    "host": "localhost",
    "port": 1883,
    "base_topic": "homie/",
    "auth": false,
    "username": null,
    "password": null,
  },
  "settings": {
  },
  "ip": null,
  "mac": null
}

/* Constructor
 *
 * Construct a new HomieDevice with a device_id or a config object containing some or all of:
 *
 * {
 *   "name": "Bare Minimum",
 *   "device_id": "bare-minimum",
 *   "mqtt": {
 *     "host": "localhost",
 *     "port": 1883,
 *     "base_topic": "devices/",
 *     "auth": false,
 *     "username": "user",
 *     "password": "pass"
 *   },
 *   "settings": {
 *     "percentage": 55 // device settings
 *   }
 * }
 *
 * Would like, but not implemented:
 *
 *   "wifi": {
 *     "ssid": "ssid",
 *     "password": "pass"
 *   },
 *   "ota": {
 *     "enabled": true
 *   }
 *
 */
var HomieDevice = module.exports = function(config) {

  var t = this;
  if (_.isString(config)) {
    config = {name: config, device_id: config};
  }
  t.config = _.extend({}, DEFAULT_CONFIG, config);

  t.name = t.config.device_id;
  t.mqttTopic = t.config.mqtt.base_topic + t.config.device_id;
  t.startTime = Date.now();

  t.nodes = {};
  t.firmwareName = null;
  t.firmwareVersion = null;
  t.statsInterval = 60;
  t.isConnected = false;
  t.mqttClient = null;
  t.friendlyName = t.config.name;
}

require('util').inherits(HomieDevice, EventEmitter);
var proto = HomieDevice.prototype;

proto.setFirmware = function(firmwareName, firmwareVersion) {
  var t = this;
  t.firmwareName = firmwareName;
  t.firmwareVersion = firmwareVersion;
}

proto.node = function(name, friendlyName, type, startRange, endRange) {
  var t = this;
  return t.nodes[name] = new HomieNode(t, name, friendlyName, type, startRange, endRange);
}

// Start the device
proto.setup = function(quiet) {
  var t = this;
  var mqttServer = 'mqtt://' + t.config.mqtt.host + ':' + t.config.mqtt.port;
  var opts = {
    will: {
      topic: t.mqttTopic + '/$state',
      payload: 'lost',
      qos: 0,
      retain: true
    }
  }
  if (t.config.mqtt.auth) {
    opts.username = t.config.mqtt.username;
    opts.password = t.config.mqtt.password;
  }
  t.mqttClient = mqtt.connect(mqttServer, opts);

  t.mqttClient.on('connect', function(connack) {
    t.onConnect();
  })

  t.mqttClient.on('close', function() {
    t.onDisconnect();
  })

  t.mqttClient.on('offline', function() {
    t.onOffline();
  })

  t.mqttClient.on('error', function(err) {
    t.onError(err);
  })
  
  t.mqttClient.on('message', function (topic, message) {
    if(message != null) {
      t.onMessage(topic, message.toString());
    } else {
      t.onMessage(topic, null);
    }
    
  })

  t.mqttClient.subscribe(t.mqttTopic + '/#');
  t.mqttClient.subscribe(t.config.mqtt.base_topic + '$broadcast/#');

  if (!quiet) {
    console.log('Connected Homie ' + t.mqttTopic + ' to ' + mqttServer);
  }
}

// Stop the device
proto.end = function() {
  var t = this;
  t.mqttClient.publish(t.mqttTopic + '/$state', 'disconnected');
  t.mqttClient.end();
}

// Called on mqtt client connect
proto.onConnect = function() {
  var t = this;
  t.isConnected = true;

  // Advertise device properties
  t.mqttClient.publish(t.mqttTopic + '/$state', 'init', {retain:true});
  t.mqttClient.publish(t.mqttTopic + '/$homie', homieVersion, {retain:true});
  t.mqttClient.publish(t.mqttTopic + '/$implementation', homieImplName, {retain:true});
  t.mqttClient.publish(t.mqttTopic + '/$implementation/version', homieImplVersion, {retain:true});
  if (t.firmwareName) {
    t.mqttClient.publish(t.mqttTopic + '/$fw/name', t.firmwareName, {retain:true});
    t.mqttClient.publish(t.mqttTopic + '/$fw/version', t.firmwareVersion, {retain:true});
  }
  t.mqttClient.publish(t.mqttTopic + '/$name', t.config.name, {retain:true});
  t.mqttClient.publish(t.mqttTopic + '/$stats', 'interval,uptime', {retain:true});

  if( t.config.mac != null) {
    t.mqttClient.publish(t.mqttTopic + '/$mac', t.config.mac, {retain:true});
  }

  if( t.config.ip != null) {
    t.mqttClient.publish(t.mqttTopic + '/$localip', t.config.ip, {retain:true});  
  }
  
  var nodes = [];
  _.each(t.nodes, function(node){
    var node = node.isRange ? node.name + '[]' : node.name;
    
    nodes.push(node);
  })
  t.mqttClient.publish(t.mqttTopic + '/$nodes', nodes.join(','), {retain:true});
  
  _.each(t.nodes, function(node){
    node.onConnect();
  })
  t.emit('connect');

  // Call the stats interval now, and at regular intervals
  t.onStatsInterval();
  t.interval = setInterval(function() {
    t.onStatsInterval();
  }, t.statsInterval * 1000);

  t.mqttClient.publish(t.mqttTopic + '/$state', 'ready', {retain:true});
}

// Called on mqtt client disconnect
proto.onDisconnect = function() {
  var t = this;
  t.isConnected = false;
  t.interval = clearInterval(t.interval);
  _.each(t.nodes, function(node){
    node.onDisconnect();
  })
  t.emit('disconnect');
}

// Called on mqtt client offline
proto.onOffline = function() {
  var t = this;
  t.emit('offline');
}

// Called on mqtt client error
proto.onError = function(err) {
  var t = this;
  t.emit('error', err);
}

// Called on every stats interval
proto.onStatsInterval = function() {
  var t = this;
  var uptime = (Date.now() - t.startTime) / 1000;
  t.mqttClient.publish(t.mqttTopic + '/$stats/uptime', '' + _.round(uptime,0), {retain:false});
  t.mqttClient.publish(t.mqttTopic + '/$stats/interval', '' + t.statsInterval, {retain:true});
  _.each(t.nodes, function(node){
    node.onStatsInterval();
  })
  t.emit('stats-interval');
}

// Called when a device message is received
proto.onMessage = function(topic, msg) {
  var t = this;
  var parts = topic.split('/');
  var deviceTopic = parts.slice(2).join('/');

  // Emit broadcast messages to broadcast listeners
  if (parts[1] == '$broadcast') {
    t.emit('broadcast', deviceTopic, msg);
    return;
  }

  // Emit to listeners of all device topics
  t.emit('message', deviceTopic, msg);

  // Emit to listeners of the specific device topic
  t.emit('message:' + deviceTopic, msg);

  // Invoke property setters if this is a property set message
  if (parts[1] == t.name && parts[4] == 'set') {
    var nodeName = parts[2];
    var propName = parts[3];
    var value = msg;
    var range = { isRange: false, index: 0 }

    if(nodeName.indexOf("_") > -1) {
      range.isRange = true;
      var nodeParts = nodeName.split('_');
      nodeName = nodeParts[0];
      range.index = parseInt(nodeParts[1])
    }
    var node = t.nodes[nodeName];

    if (node) {
      if (node.isRange !== range.isRange) {
        return;
      }
      
      var prop = node.props[propName];
      if (prop && _.isFunction(prop.setter)) {
        // This interface is consistent with esp8266 homie
        prop.setter(range, value);
      }
    }
  }
}
