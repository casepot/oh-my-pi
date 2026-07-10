<system-notice>
{{#if multiple}}{{#if hasTask}}{{jobs.length}} background jobs produced results. Resume your work using the exact outcomes below.{{else}}{{jobs.length}} background jobs have completed. Resume your work using the results below.{{/if}}

{{else}}{{#if jobs.[0].task}}Background task {{jobs.[0].jobId}} {{jobs.[0].status}}. Resume your work using the exact result below.{{else}}Background job {{jobs.[0].jobId}} has completed. Resume your work using the result below.{{/if}}
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}}{{#if this.task}} [{{this.status}}]{{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
