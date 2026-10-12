import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { calibrationProfiles, movement, referenceStages, sleepRecords, vitals } from '@/src/db/biometrics-schema'
import { sideSettings } from '@/src/db/schema'
import { and, asc, desc, eq, gt, gte, lte } from 'drizzle-orm'
import { sideSchema } from '@/src/server/validation-schemas'
import {
  calculateDistribution,
  calculateQualityScore,
  classifySleepStages,
  mergeIntoBlocks,
  piezoCalibrationQuality,
  scoreAgainstReference,
} from '@/src/lib/sleep-stages'
import {
  DEFAULT_STAGE_CLASSIFIER,
  resolveStageClassifier,
  stageClassifierSchema,
  STAGE_ENGINES,
  STAGE_RULESET_PRESETS,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

type Side = 'left' | 'right'

/** The side's stored classifier, or the defaults. */
export async function loadStageClassifier(side: Side): Promise<StageClassifier> {
  const [row] = await db
    .select({ stageClassifier: sideSettings.stageClassifier })
    .from(sideSettings)
    .where(eq(sideSettings.side, side))
    .limit(1)
  return resolveStageClassifier(row?.stageClassifier)
}

/** Vitals, movement and piezo calibration quality for one side's window. */
export async function loadStageInputs(side: Side, windowStart: Date, windowEnd: Date) {
  const vitalsData = await biometricsDb
    .select()
    .from(vitals)
    .where(
      and(
        eq(vitals.side, side),
        gte(vitals.timestamp, windowStart),
        lte(vitals.timestamp, windowEnd)
      )
    )
    .orderBy(asc(vitals.timestamp))

  const movementData = await biometricsDb
    .select()
    .from(movement)
    .where(
      and(
        eq(movement.side, side),
        gte(movement.timestamp, windowStart),
        lte(movement.timestamp, windowEnd)
      )
    )
    .orderBy(asc(movement.timestamp))

  const [piezoProfile] = await biometricsDb
    .select({ qualityScore: calibrationProfiles.qualityScore })
    .from(calibrationProfiles)
    .where(
      and(
        eq(calibrationProfiles.side, side),
        eq(calibrationProfiles.sensorType, 'piezo'),
      )
    )
    .limit(1)

  return { vitalsData, movementData, calibrationQuality: piezoCalibrationQuality(piezoProfile) }
}

const stageEnum = z.enum(['wake', 'light', 'deep', 'rem'])

const nightStagesSchema = z.object({
  blocks: z.array(z.object({ start: z.number(), end: z.number(), stage: stageEnum })),
  distribution: z.object({ wake: z.number(), light: z.number(), deep: z.number(), rem: z.number() }),
  qualityScore: z.number(),
  totalSleepMs: z.number(),
  agreement: z.object({
    epochs: z.number(),
    accuracy: z.number(),
    kappa: z.number().nullable(),
  }).nullable(),
})

const classifierStateSchema = z.object({
  classifier: stageClassifierSchema,
  isDefault: z.boolean(),
})

export const sleepStagesRouter = router({
  /**
   * How a side's sleep stages are classified, plus the defaults, the
   * available engines, and the built-in presets to start a custom ruleset from.
   */
  getClassifier: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/sleep-stages/classifier', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(classifierStateSchema.extend({
      defaults: stageClassifierSchema,
      engines: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
      presets: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), classifier: stageClassifierSchema })),
    }))
    .query(async ({ input }) => {
      try {
        const [row] = await db
          .select({ stageClassifier: sideSettings.stageClassifier })
          .from(sideSettings)
          .where(eq(sideSettings.side, input.side))
          .limit(1)
        const stored = row?.stageClassifier ?? null
        return {
          classifier: resolveStageClassifier(stored),
          isDefault: stored === null || !stageClassifierSchema.safeParse(stored).success,
          defaults: DEFAULT_STAGE_CLASSIFIER,
          engines: Object.entries(STAGE_ENGINES).map(([id, e]) => ({ id, ...e })),
          presets: Object.entries(STAGE_RULESET_PRESETS).map(([id, p]) => ({
            id,
            label: p.label,
            description: p.description,
            classifier: { engine: 'rules' as const, ruleset: p.ruleset },
          })),
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to load stage classifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Save a side's classifier, or pass null to go back to the defaults. Stages
   * are classified on read, so every stored night re-scores with it.
   */
  setClassifier: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/sleep-stages/classifier', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({ side: sideSchema, classifier: stageClassifierSchema.nullable() }).strict())
    .output(classifierStateSchema)
    .mutation(async ({ input }) => {
      try {
        const updated = await db
          .update(sideSettings)
          .set({ stageClassifier: input.classifier, updatedAt: new Date() })
          .where(eq(sideSettings.side, input.side))
          .returning({ side: sideSettings.side })
        if (updated.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Side settings for ${input.side} not found` })
        }
        return {
          classifier: input.classifier ?? DEFAULT_STAGE_CLASSIFIER,
          isDefault: input.classifier === null,
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to save stage classifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Classify one night with the side's saved classifier and with a candidate,
   * without saving. Each result carries its agreement with reference stages
   * (Apple Watch) when the night has any. Defaults to the latest night.
   */
  previewClassifier: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/sleep-stages/classifier/preview', protect: false, tags: ['Sleep stages'] } })
    .input(z.object({
      side: sideSchema,
      sleepRecordId: z.number().int().optional(),
      classifier: stageClassifierSchema,
    }).strict())
    .output(z.object({
      sleepRecordId: z.number().nullable(),
      enteredBedAt: z.number().nullable(),
      leftBedAt: z.number().nullable(),
      hasReference: z.boolean(),
      saved: nightStagesSchema.nullable(),
      candidate: nightStagesSchema.nullable(),
    }))
    .mutation(async ({ input }) => {
      try {
        const [record] = await biometricsDb
          .select()
          .from(sleepRecords)
          .where(input.sleepRecordId === undefined
            ? eq(sleepRecords.side, input.side)
            : and(eq(sleepRecords.id, input.sleepRecordId), eq(sleepRecords.side, input.side)))
          .orderBy(desc(sleepRecords.enteredBedAt))
          .limit(1)

        if (!record) {
          if (input.sleepRecordId !== undefined) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Sleep record ${input.sleepRecordId} not found for side '${input.side}'`,
            })
          }
          return { sleepRecordId: null, enteredBedAt: null, leftBedAt: null, hasReference: false, saved: null, candidate: null }
        }

        const windowStart = record.enteredBedAt
        const windowEnd = record.leftBedAt
        const { vitalsData, movementData, calibrationQuality } = await loadStageInputs(input.side, windowStart, windowEnd)
        const reference = (await biometricsDb
          .select()
          .from(referenceStages)
          .where(
            and(
              eq(referenceStages.side, input.side),
              lte(referenceStages.start, windowEnd),
              gt(referenceStages.end, windowStart)
            )
          )
          .orderBy(asc(referenceStages.start)))
          .map(r => ({ start: r.start.getTime(), end: r.end.getTime(), stage: r.stage }))
        const saved = await loadStageClassifier(input.side)

        const classify = (classifier: StageClassifier) => {
          const epochs = classifySleepStages(vitalsData, movementData, calibrationQuality, classifier.ruleset)
          if (epochs.length === 0) return null
          const distribution = calculateDistribution(epochs)
          return {
            blocks: mergeIntoBlocks(epochs),
            distribution,
            qualityScore: calculateQualityScore(distribution, calibrationQuality),
            totalSleepMs: epochs.reduce((sum, e) => sum + e.duration, 0),
            agreement: scoreAgainstReference(epochs, reference),
          }
        }

        return {
          sleepRecordId: record.id,
          enteredBedAt: record.enteredBedAt.getTime(),
          leftBedAt: record.leftBedAt.getTime(),
          hasReference: reference.length > 0,
          saved: classify(saved),
          candidate: classify(input.classifier),
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to preview stage classifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
