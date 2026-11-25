import { makePlan } from './phase12d-calibration.ts';
await makePlan(process.argv[2] === 'qualifier-v2');
