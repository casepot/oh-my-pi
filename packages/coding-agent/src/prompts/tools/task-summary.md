<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
<termination>
{{terminationJson}}
</termination>
{{#if retryFailureJson}}
<retry-failure>
{{retryFailureJson}}
</retry-failure>
{{/if}}
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if providerNotice}}<notice>{{providerNotice}}</notice>{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `irc` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
