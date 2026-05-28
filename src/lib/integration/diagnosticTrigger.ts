// src/lib/integration/diagnosticTrigger.ts
import { getSequenceManager } from "../email/sequenceManager";
import { LeadDatabase, DiagnosticData, LeadData } from "../database/sqlite";
import { v4 as uuidv4 } from "uuid";

// Interface para el resultado del procesamiento
export interface ProcessDiagnosticResult {
  isNewLead: boolean;
  leadId: string;
  emailsToSend: Array<{
    template: string;
    day: number;
    subject: string;
  }>;
  message: string;
}

// Interface para métricas
export interface DiagnosticMetrics {
  totalLeads: number;
  activeSequences: number;
  emailsSent: number;
}

// Interface para el resultado de emails programados
export interface ScheduledEmailsResult {
  processed: number;
  sent: number;
  failed: number;
}

// Interface para submission de diagnóstico - EXPORTADA
export interface DiagnosticSubmission {
  email: string;
  name: string;
  company?: string;
  diagnosticResult: {
    score: number;
    level: string;
    recommendations: string[];
    areas: {
      dataCollection: number;
      analysis: number;
      visualization: number;
      decisionMaking: number;
    };
  };
  submissionDate: string;
}

export class DiagnosticTrigger {
  private database: LeadDatabase;
  private sequenceManager: unknown; // CAMBIO: Usar unknown en lugar de Record<string, unknown>

  constructor() {
    this.database = new LeadDatabase();
    this.sequenceManager = getSequenceManager();
  }

  /**
   * Procesar diagnóstico - método principal
   */
  async processDiagnostic(
    submission: DiagnosticSubmission
  ): Promise<ProcessDiagnosticResult> {
    try {
      // Validar entrada
      this.validateSubmission(submission);

      const existingLead = this.database.findLeadByEmail(submission.email);

      if (existingLead) {
        return await this.updateExistingLead(existingLead, submission);
      } else {
        return await this.createNewLead(submission);
      }
    } catch (error) {
      console.error("❌ Error procesando diagnóstico:", error);
      throw error;
    }
  }

  /**
   * Crear nuevo lead
   */
  private async createNewLead(
    submission: DiagnosticSubmission
  ): Promise<ProcessDiagnosticResult> {
    const leadId = uuidv4();

    const diagnosticData: DiagnosticData = {
      score: submission.diagnosticResult.score,
      level: submission.diagnosticResult.level,
      recommendations: submission.diagnosticResult.recommendations,
      areas: submission.diagnosticResult.areas,
    };

    // Construir objeto base
    const newLead: LeadData = {
      id: leadId,
      email: submission.email,
      name: submission.name,
      diagnosticDate: submission.submissionDate,
      emailsSent: [],
      sequencePaused: false,
      diagnosticData,
    };

    // Añadir company solo si existe
    if (submission.company) {
      newLead.company = submission.company;
    }

    // Guardar en base de datos
    this.database.upsertLead(newLead);

    // Fresh submissions send only the immediate welcome email. Short backfills
    // can catch up on delayed follow-ups; very old imports restart at welcome.
    const daysElapsed = this.database.getDaysElapsed(leadId);
    const emailsToSend =
      daysElapsed > 2 && daysElapsed <= 10
        ? this.calculateEmailsToSend(newLead).filter((email) => email.day > 0)
        : this.calculateEmailsToSend(newLead).filter((email) => email.day === 0);

    // Enviar emails inmediatos
    await this.sendScheduledEmails(leadId, emailsToSend);

    return {
      isNewLead: true,
      leadId,
      emailsToSend,
      message: `Nuevo lead creado. ${emailsToSend.length} emails programados.`,
    };
  }

  /**
   * Actualizar lead existente
   */
  private async updateExistingLead(
    existingLead: LeadData,
    submission: DiagnosticSubmission
  ): Promise<ProcessDiagnosticResult> {
    // Actualizar datos
    const updatedDiagnosticData: DiagnosticData = {
      score: submission.diagnosticResult.score,
      level: submission.diagnosticResult.level,
      recommendations: submission.diagnosticResult.recommendations,
      areas: submission.diagnosticResult.areas,
    };

    // Construir objeto actualizado paso a paso
    const updatedLead: LeadData = {
      id: existingLead.id,
      email: existingLead.email,
      name: submission.name,
      diagnosticDate: existingLead.diagnosticDate,
      emailsSent: existingLead.emailsSent,
      sequencePaused: existingLead.sequencePaused,
      diagnosticData: updatedDiagnosticData,
    };

    // Añadir propiedades opcionales solo si existen
    if (submission.company) {
      updatedLead.company = submission.company;
    } else if (existingLead.company) {
      updatedLead.company = existingLead.company;
    }

    if (existingLead.lastEmailSent) {
      updatedLead.lastEmailSent = existingLead.lastEmailSent;
    }

    if (existingLead.pauseReason) {
      updatedLead.pauseReason = existingLead.pauseReason;
    }

    if (existingLead.createdAt) {
      updatedLead.createdAt = existingLead.createdAt;
    }

    if (existingLead.updatedAt) {
      updatedLead.updatedAt = existingLead.updatedAt;
    }

    // Guardar cambios
    this.database.upsertLead(updatedLead);

    // Calcular emails pendientes (excluyendo ya enviados)
    const emailsToSend = this.calculateEmailsToSend(updatedLead);

    return {
      isNewLead: false,
      leadId: existingLead.id,
      emailsToSend,
      message: `Lead actualizado. ${emailsToSend.length} emails enviados.`,
    };
  }

  /**
   * Calcular emails que deben enviarse según días transcurridos
   */
  // En src/lib/integration/diagnosticTrigger.ts
  private calculateEmailsToSend(lead: LeadData): Array<{
    template: string;
    day: number;
    subject: string;
  }> {
    const daysElapsed = this.database.getDaysElapsed(lead.id);
    const emailsToSend = [];

    // Secuencia de emails programados
    const emailSequence = [
      { day: 0, template: "diagnostic_welcome", subject: "Bienvenida" },
      { day: 2, template: "diagnostic_followup_1", subject: "Seguimiento 1" },
      { day: 5, template: "diagnostic_followup_2", subject: "Seguimiento 2" },
      { day: 10, template: "diagnostic_followup_3", subject: "Seguimiento 3" },
    ];

    for (const emailConfig of emailSequence) {
      // FIX: Solo incluir si es exactamente el día correcto Y no se ha enviado
      if (
        daysElapsed >= emailConfig.day &&
        !this.database.wasEmailSent(lead.id, emailConfig.day)
      ) {
        emailsToSend.push(emailConfig);
      }
    }

    return emailsToSend;
  }

  private calculatePendingEmails(lead: LeadData): Array<{
    template: string;
    day: number;
    subject: string;
  }> {
    const daysElapsed = this.database.getDaysElapsed(lead.id);
    const emailsToSend = [];

    const emailSequence = [
      { day: 0, template: "diagnostic_welcome", subject: "Bienvenida" },
      { day: 2, template: "diagnostic_followup_1", subject: "Seguimiento 1" },
      { day: 5, template: "diagnostic_followup_2", subject: "Seguimiento 2" },
      { day: 10, template: "diagnostic_followup_3", subject: "Seguimiento 3" },
    ];

    for (const emailConfig of emailSequence) {
      // Para cron: incluir si ya debería haberse enviado
      if (
        daysElapsed >= emailConfig.day &&
        !this.database.wasEmailSent(lead.id, emailConfig.day)
      ) {
        emailsToSend.push(emailConfig);
      }
    }

    return emailsToSend;
  }

  /**
   * Enviar emails programados
   */
  private async sendScheduledEmails(
    leadId: string,
    emails: Array<{ template: string; day: number; subject: string }>
  ): Promise<void> {
    for (const email of emails) {
      try {
        // Registrar email como enviado
        this.database.logEmailSent({
          leadId,
          templateName: email.template,
          sequenceDay: email.day,
          subject: email.subject,
          status: "sent",
        });

        console.log(
          `📧 Email enviado: ${email.template} (Day ${email.day}) para lead ${leadId}`
        );
      } catch (error) {
        console.error(`❌ Error enviando email ${email.template}:`, error);

        // Registrar error
        this.database.logEmailSent({
          leadId,
          templateName: email.template,
          sequenceDay: email.day,
          subject: email.subject,
          status: "failed",
        });
      }
    }
  }

  /**
   * Procesar emails programados (para cron jobs)
   */
  async processScheduledEmails(): Promise<ScheduledEmailsResult> {
    try {
      const pendingLeads = this.database.getLeadsPendingEmails();
      let processed = 0;
      let sent = 0;
      let failed = 0;

      console.log(`🔍 Procesando ${pendingLeads.length} leads pendientes`);

      for (const lead of pendingLeads) {
        // FIX: Usar calculatePendingEmails
        const emailsToSend = this.calculatePendingEmails(lead);

        if (emailsToSend.length > 0) {
          processed++;

          try {
            await this.sendScheduledEmails(lead.id, emailsToSend);
            sent += emailsToSend.length;
          } catch (error) {
            failed++;
            console.error(`❌ Error procesando lead ${lead.id}:`, error);
          }
        }
      }

      console.log(
        `📊 Resumen: ${processed} procesados, ${sent} enviados, ${failed} fallidos`
      );
      return { processed, sent, failed };
    } catch (error) {
      console.error("❌ Error en processScheduledEmails:", error);
      return { processed: 0, sent: 0, failed: 0 };
    }
  }

  /**
   * Obtener métricas
   */
  getMetrics(): DiagnosticMetrics {
    try {
      const dbMetrics = this.database.getMetrics();

      return {
        totalLeads: dbMetrics.totalLeads,
        activeSequences: dbMetrics.activeSequences,
        emailsSent: dbMetrics.emailsSentToday,
      };
    } catch (error) {
      console.error("❌ Error obteniendo métricas:", error);
      return {
        totalLeads: 0,
        activeSequences: 0,
        emailsSent: 0,
      };
    }
  }

  /**
   * Validar submission
   */
  private validateSubmission(submission: DiagnosticSubmission): void {
    if (!submission.email || !this.isValidEmail(submission.email)) {
      throw new Error("Email inválido");
    }

    if (!submission.name || submission.name.trim().length === 0) {
      throw new Error("Nombre requerido");
    }

    if (
      !submission.submissionDate ||
      !this.isValidDate(submission.submissionDate)
    ) {
      throw new Error("Fecha de submisión inválida");
    }

    if (
      !submission.diagnosticResult ||
      typeof submission.diagnosticResult.score !== "number"
    ) {
      throw new Error("Resultado de diagnóstico inválido");
    }
  }

  /**
   * Validar email
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validar fecha
   */
  private isValidDate(dateString: string): boolean {
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  }

  /**
   * Cerrar conexión de base de datos
   */
  close(): void {
    this.database.close();
  }
}

// Instancia singleton para uso en la aplicación
let diagnosticTriggerInstance: DiagnosticTrigger | null = null;

export const getDiagnosticTrigger = (): DiagnosticTrigger => {
  if (!diagnosticTriggerInstance) {
    diagnosticTriggerInstance = new DiagnosticTrigger();
  }
  return diagnosticTriggerInstance;
};

export const createDiagnosticTrigger = (): DiagnosticTrigger => {
  return new DiagnosticTrigger();
};
