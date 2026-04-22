import type { Exercise } from './types';
import type { WorkoutTemplate } from './types';

export const DEFAULT_EXERCISES: readonly Exercise[] = [
  { id: 'sq', name: 'Back Squat', muscles: ['quads', 'glutes'], equipment: 'barbell', incrementKg: 2.5 },
  { id: 'bp', name: 'Bench Press', muscles: ['chest', 'triceps'], equipment: 'barbell', incrementKg: 2.5 },
  { id: 'dl', name: 'Deadlift', muscles: ['posterior', 'back'], equipment: 'barbell', incrementKg: 5 },
  { id: 'ohp', name: 'Overhead Press', muscles: ['shoulders', 'triceps'], equipment: 'barbell', incrementKg: 2.5 },
  { id: 'row', name: 'Barbell Row', muscles: ['back'], equipment: 'barbell', incrementKg: 2.5 },
  { id: 'pullup', name: 'Pull-up', muscles: ['back', 'biceps'], equipment: 'bodyweight', incrementKg: 2.5 },
  { id: 'dip', name: 'Dip', muscles: ['chest', 'triceps'], equipment: 'bodyweight', incrementKg: 2.5 },
  { id: 'curl', name: 'Dumbbell Curl', muscles: ['biceps'], equipment: 'dumbbell', incrementKg: 1 },
  { id: 'lat', name: 'Lat Pulldown', muscles: ['back'], equipment: 'cable', incrementKg: 2.5 },
  { id: 'legpress', name: 'Leg Press', muscles: ['quads', 'glutes'], equipment: 'machine', incrementKg: 5 },
];

export const DEFAULT_TEMPLATES: readonly WorkoutTemplate[] = [
  {
    id: 'tpl-push-a',
    name: 'Push A',
    createdAt: new Date(0).toISOString(),
    exercises: [
      { exerciseId: 'bp', sets: 4, targetReps: 8, targetRpe: 8 },
      { exerciseId: 'ohp', sets: 3, targetReps: 8, targetRpe: 8 },
      { exerciseId: 'dip', sets: 3, targetReps: 10, targetRpe: 8 },
    ],
  },
  {
    id: 'tpl-pull-a',
    name: 'Pull A',
    createdAt: new Date(0).toISOString(),
    exercises: [
      { exerciseId: 'row', sets: 4, targetReps: 8, targetRpe: 8 },
      { exerciseId: 'lat', sets: 3, targetReps: 10, targetRpe: 8 },
      { exerciseId: 'curl', sets: 3, targetReps: 12, targetRpe: 8 },
    ],
  },
  {
    id: 'tpl-legs-a',
    name: 'Legs A',
    createdAt: new Date(0).toISOString(),
    exercises: [
      { exerciseId: 'sq', sets: 4, targetReps: 6, targetRpe: 8 },
      { exerciseId: 'legpress', sets: 3, targetReps: 12, targetRpe: 8 },
      { exerciseId: 'dl', sets: 2, targetReps: 5, targetRpe: 8 },
    ],
  },
];
