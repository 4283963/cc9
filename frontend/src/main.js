import { DigitalTwinApp } from './app/DigitalTwinApp.js';

const container = document.getElementById('app');
const app = new DigitalTwinApp(container);

window.app = app;

window.addEventListener('beforeunload', () => {
  if (app) {
    app.destroy();
  }
});
