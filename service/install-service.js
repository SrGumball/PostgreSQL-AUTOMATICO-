var Service = require('node-windows').Service;
var path = require('path');

// Criar um novo objeto de Serviço
var svc = new Service({
  name: 'PostgreSQL Backup Manager',
  description: 'Motor de backup e monitoramento contínuo do PostgreSQL.',
  script: path.join(__dirname, 'index.js'),
  env: [{
    name: "NODE_ENV",
    value: "production"
  }]
});

// Escutar evento de instalação
svc.on('install', function() {
  console.log('Serviço instalado com sucesso no services.msc do Windows!');
  console.log('Iniciando o serviço...');
  svc.start();
});

svc.on('alreadyinstalled', function() {
  console.log('O serviço já está instalado.');
});

// Instalar o serviço
svc.install();
