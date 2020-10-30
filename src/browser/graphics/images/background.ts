import backgroundBrown from './Literaciful-genkai.png';
// import backgroundBrown from './background-brown.png';
import backgroundBlue from './Literaciful-genkai.png';

export const background =
	nodecg.bundleConfig.colorTheme === 'blue'
		? backgroundBrown
		: backgroundBlue;
