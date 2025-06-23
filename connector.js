// connector.js (from user prompt, for test context)
export class Connector {
    static EXECUTION_TYPE = {
        STACK_ENTRY: "stackEntry",
        STACK_EXCEPTION: "stackException",
        STACK_RETURN: "stackReturn",
        SLOP_CALL: "slopCall",
        SLOP_SYNTAX_EXCEPTION: "slopSyntaxException",
        SLOP_EXCEPTION: "slopException",
        SLOP_RETURN: "slopReturn",
        TOOL_CALL: "toolCall",
        TOOL_EXCEPTION: "toolException",
        TOOL_RETURN: "toolReturn",
    };
    constructor(name){
        this.name = name;
        this.executionListeners = [];
    }
    async run(callback) {
        let callReference = {};
        window.SlopScript.connectorStack.push(this);
        this.notifyExecutionListeners({
            reference: callReference,
            type: Connector.EXECUTION_TYPE.STACK_ENTRY,
            context: { call: callback, connector: this }
        });
        let result;
        try {
            result = await callback();
        } catch (ex){
            this.notifyExecutionListeners({
                reference: callReference,
                type: Connector.EXECUTION_TYPE.STACK_EXCEPTION,
                context: { call: callback, connector: this, error: ex }
            });
            throw ex;
        } finally {
            this.notifyExecutionListeners({
                reference: callReference,
                type: Connector.EXECUTION_TYPE.STACK_RETURN,
                context: { call: callback, connector: this, returnValue: result }
            });
            let connector = window.SlopScript.connectorStack.pop();
            if (connector!==this){
                console.warn("FIXME: SlopScript connector stack inconsistency detected, stack has crashed! Popped a connector different than the expected 'this'", connector, this);
                throw new Error("SlopScript connector stack crashed! Execution stopped");
            }
        }
        return result;
    }
    notifyExecutionListeners(stateUpdate){
        this.executionListeners.forEach(listener=>{
            try { listener.callback(stateUpdate); } catch (ex){ console.warn("SlopScript Connector execution listener failed during notify:", ex); }
        });
        window.SlopScript.connectorStack.forEach(stackFrame=>{
            if (stackFrame===this) return;
            stackFrame.executionListeners.forEach(listener=>{
                if (listener.subtree){
                    try { listener.callback(stateUpdate); } catch (ex){ console.warn("SlopScript Connector execution listener failed during notify:", ex); }
                }
            });
        });
    }
    addExecutionListener(callback, options={}){
        let listener = Object.assign({}, options, {callback:callback});
        this.executionListeners.push(listener);
    }
    removeExecutionListener(callback){
        this.executionListeners = this.executionListeners.filter(listener=>{
            listener.callback!=callback
        });
    }
    static getCurrent(){
        if (!window.SlopScript || !window.SlopScript.connectorStack) throw new Error("Attempt to access Connector.getCurrent() without a running SlopScript environment, was SlopScript properly initialized?");
        if (window.SlopScript.connectorStack.length<1) throw new Error("No SlopScript Connector while calling Connector.getCurrent() - Are you calling SlopScript code without a wrapping aiConnector.run(()=>{...} call?");
        return window.SlopScript.connectorStack[SlopScript.connectorStack.length-1];
    }
}
