// The entry point: find the container and mount the game.
import { mount } from './mount';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('Railroad Route: #app container missing from index.html');
}

mount(root);
