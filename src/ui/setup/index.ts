// [shell] The setup steps in wizard order. Each step is a self-contained module (see kit.ts SetupStep), so a later
// version can launch any one alone via mountWizard(root, api, { steps: ['drums'], ... }).
import { commandsStep } from './commands.ts';
import { drumsStep } from './drums.ts';
import { latencyStep } from './latency.ts';
import { listeningStep } from './listening.ts';
import { micStep } from './mic.ts';
import type { SetupStep } from './kit.ts';
import { voiceStep } from './voice.ts';

export const ALL_STEPS: SetupStep[] = [listeningStep, micStep, latencyStep, drumsStep, voiceStep, commandsStep];
export type { SetupStep } from './kit.ts';
