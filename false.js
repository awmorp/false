/* False interpreter in Javascript */
/* Anthony Morphett - awmorp@gmail.com */
/* December 2009 */

/* TODO:
 - Parsing bug: [ '] ]! is not parsed correctly.  (Fix will require token-by-token parsing in ParseFunction, rather than character-by-character. Should '}, '{ be treated the same?)
 - Implement 'Step over'
 - fix up stepping & program display - should always display the next opcode to be executed, even after function return
 - fix up exception handling in a few places
 - better IO
 - improved typecasting?
 - Strictly False extensions?
 - interface improvements
*/

/* Ideas for future extensions:
 - add stacks as a data type; add the ability to push/pop stacks to the stack. This will allow lists, trees, etc.
 - would it be possible to represent integers as stacks (analogously to how numbers are represented in lambda calculus)? ie, '0' is the empty stack, '1' is the stack containing only the empty stack, etc
*/


let g_nDebugLevel = 1;

/* Current continuation and step timer */

let g_oTimer = null;
let g_nStepPeriod = 100;  /* milliseconds between steps */
let g_oCurrentContinuation = null;

let g_bTurbo = false;
let g_bRunning = true;

let g_nStepCount = 0;
let g_nStartTime = 0;

/* UI helper global variables */

let g_zActiveFunction = "";
let g_nActivePosition = 0;

/* Input buffer */

let g_zInputBuf = "";

/* Output */
let g_zOutput = "";

/** Storage object **/

let Storage = {
  aData: new Object,
  
  clear: function()
  {
    this.aData = new Object;
  },
  
  getData: function( zName )
  {
    let z = this.aData[ zName ];
    if( z == null ) {
      throw( new Error( "Attempt to retrieve uninitialised variable '" + zName + "'!" ) );
    } else {
      return( z );
    }
  },
  
  setData: function( zName, x )
  {
    this.aData[ zName ] = x;
  },
  
  dump: function()
  {
    let str = "";
    let bFirst = true;
    for( const x in this.aData ) {
      if( !bFirst ) str += ", ";
      str += x;
      str += ' = ';
      str += DumpVar( this.aData[ x ] );
      bFirst = false;
    }
    return( str );
  }
};

/** Stack object **/

let Stack = {
  aData: new Array,

  clear: function()
  {
    this.aData = new Array;
  },
  
  size: function()
  {
    return( this.aData.length );
  },
  
  pushVar: function( x )
  {
    this.aData.push( x );
  },
  
  popVar : function()
  {
    if( this.aData.length < 1 ) throw( new Error( "Attempt to pop on empty stack!" ) );
    return( this.aData.pop() );
  },
  
  pushInt : function( x )
  {
    let a = new Object;
    a.value = x;
    a.type = "int";
    this.aData.push( a );
  },
  
  pushBool : function( x )
  {
    let a = new Object;
    a.value = x;
    a.type = "bool";
    this.aData.push( a );
  },
  
  pushString : function( x )
  {
    let a = new Object;
    a.value = x;
    a.type = "string";
    this.aData.push( a );
  },
  
  pushFunction : function( x )
  {
    let a = new Object;
    a.value = x;
    a.type = "function";
    this.aData.push( a );
  },
  
  popInt : function()
  {
    let a = this.popVar();
    if( a.type != "int" ) {
      if( a.type == "bool" ) {
        debug( 1, "Warning: typecast from bool to int!" );
        return( a.value ? -1 : 0 );
      }
      this.pushVar( a );
      throw( new Error( "Type error: " + a.type + " found when int expected!" ) );
    } else {
      return( a.value );
    }
  },
  
  popBool : function()
  {
    let a = this.popVar();
    if( a.type != "bool" ) {
      if( a.type == "int" ) {
        debug( 1, "Warning: typecast from int to bool!" );
        return( a.value != 0 ? true : false );
      }
      this.pushVar( a );
      throw( new Error( "Type error: " + a.type + " found when bool expected!" ) );
    } else {
      return( a.value );
    }
  },
  
  popString : function()
  {
    let a = this.popVar();
    if( a.type != "string" ) {
      this.pushVar( a );
      throw( new Error( "Type error: popString tried to pop a " + a.type + "!" ) );
    } else {
      return( a.value );
    }
  },
  
  popFunction : function()
  {
    let a = this.popVar();
    if( a.type != "function" ) {
      if( a.type == "string" ) {
        debug( 1, "Warning: typecast from string to function!" );
        return( a.value );
      }
      this.pushVar( a );
      throw( new Error( "Type error: " + a.type + " found when function expected!" ) );
    } else {
      return( a.value );
    }
  },
  
  getVar : function( n )
  {
    return( this.aData[ this.aData.length - n - 1 ] );
  },
  
  dropVar : function( n )
  {
    return( this.aData.splice( this.aData.length - n, 1 ) );
  },
  
  dump : function()
  {
    let str = "";
    let bFirst = true;
    for( x in this.aData ) {
      if( !bFirst ) str += ", ";
      str += DumpVar( this.aData[x] );
      bFirst = false;
    }
    return( str );
  }
}; /* end Stack object */

function DumpVar( a )
{
  switch( a.type ) {
    case "int":
      return( a.value );
    case "bool":
      return( a.value ? "true" : "false" );
    case "string":
      return '"' + a.value + '"';
    case "function":
      return '[' + a.value + ']';
    default:
      return a.value;
  } 
}

function DumpState()
{
  return( "Stack: " + Stack.dump() + "\nStorage: " + Storage.dump() );
}

/* Execute the next command in a string of program code */
function ExecuteStep( zString, nPos, oFinalContinuation )
{
  if( nPos >= zString.length ) {
    /* Finished executing this function. Return to caller via continuation. */
    oFinalContinuation();
    return;
  }
  
  g_nStepCount++;
  
  debug( 5, "ExecuteStep( '" + zString + "', " + nPos + " )" );

  let oNextContinuation = null;
  
  let zActiveString = zString.substring( nPos );
  let token = zActiveString.charAt( 0 );
  
  let nLength = 0;
  let bUIUpdated = false;
  
  try {
    if( isdigit( token ) )
    {
      nLength = ParseNumber( zActiveString );
    }
    else if( isalpha( token ) )
    {
      nLength = ParseName( zActiveString );
    }
    else if( token == "{" )
    {
      nLength = ParseComment( zActiveString );
    }
    else if( token == "[" )
    {
      nLength = ParseFunction( zActiveString );
    }
    else if( token == "\"" )  /* double-quote */
    {
      nLength = ParseString( zActiveString );
    }
    else if( token == "'" )  /* literal character */
    {
      nLength = ParseChar( zActiveString );
    }
    else {
      let a, b, c, oReturnContinuation;
      switch( token )   /* Handle single-char opcodes */
      {
        case "+":
        {
          /* Integer addition */
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushInt( a + b );
          break;
        }
        case "-":
        {
          /* Integer subtraction */
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushInt( b - a );
          break;
        }
        case "_":
        {
          /* Unary integer negation */
          a = Stack.popInt();
          Stack.pushInt( -a );
          break;
        }
        case "*":
        {
          /* Integer multiplication */
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushInt( a * b );
          break;
        }
        case "/":
        {
          /* Integer division */
          a = Stack.popInt();
          b = Stack.popInt();
          if( a == 0 ) {
            throw( new Error( "Attempt to divide by zero!" ) );
          }
          Stack.pushInt( b / a );
          break;
        }
        case "=":
        {
          /* Equality comparison */
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushBool( a == b );
          break;
        }
        case ">":
        {
          /* Magnitude comparison */
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushBool( b > a );
          break;
        }
        case "~":
        {
          /* Boolean negation */
          a = Stack.popBool();
          Stack.pushBool( !a );
          break;
        }
        case "&":
        {
          /* Boolean and */
          a = Stack.popBool();
          b = Stack.popBool();
          Stack.pushBool( a && b );
          break;
        }
        case "|":
        {
          /* Boolean or */
          a = Stack.popBool();
          b = Stack.popBool();
          Stack.pushBool( a || b );
          break;
        }
        case "¬":
        {
          /* Bitwise not */
          a = Stack.popInt();
          Stack.pushInt(~a);
          break;
        }
        case "∧":
        {
          /* Bitwise and*/
          a = Stack.popInt();
          b = Stack.popInt()
          Stack.pushInt(a & b);
          break;
        }
        case "∨":
        {
          /* Bitwise or*/
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushInt(a | b);
          break;
        }
        case "⩒":
        {
          /* Bitwise xor*/
          a = Stack.popInt();
          b = Stack.popInt();
          Stack.pushInt(a ^ b);
          break;
        }
        case "$":
        {
          /* Duplicate top of stack */
          a = Stack.popVar();
          Stack.pushVar( a );
          Stack.pushVar( a );
          break;
        }
        case "%":
        {
          /* Delete top of stack */
          a = Stack.popVar();
          break;
        }
        case "\\":
        {
          /* Swap top 2 stack elements */
          a = Stack.popVar();
          b = Stack.popVar();
          Stack.pushVar( a );
          Stack.pushVar( b );
          break;
        }
        case "@":
        {
          /* Rotate top 3 stack elements */
          a = Stack.popVar();
          b = Stack.popVar();
          c = Stack.popVar();
          Stack.pushVar( b );
          Stack.pushVar( a );
          Stack.pushVar( c );
          break;
        }
        case "ø":
        {
          /* Pick (copy nth stack element to top) */
          /* Funky opcode character is supported for compatibility reasons */
          /* Is there another opcode character we could use here? */
          a = Stack.popInt();
          if( a < 0n || a >= 9007199254740991n || a >= Stack.size() ) {
            throw( new Error( "Argument " + a + " out of range for pick opcode!" ) );
          }
          b = Stack.getVar( Number( a ) );
          Stack.pushVar( b );
          
          break;
        }
        case "®":
        {
            /* Rotate top n stack elements */
            /* Pops an integer n from the stack, then rotates the top n stack elements (not including n itself) */
            n = Stack.popInt();
            if( n < 0n || n > 9007199254740991n || n > Stack.size() ) {
              throw( new Error( "Argument " + n + " out of range for rotate n opcode!" ) );
            }
            if( n > 1n ) {   /* 'Rotate 0' or 'Rotate 1' has no effect, so do nothing in that case */
              a = Stack.dropVar( Number( n ) )[0];
              Stack.pushVar( a );
            }
            
            break;
        }
        case "!":
        {
          /* Apply function */
          a = Stack.popFunction();
          
          oReturnContinuation = function() {
            ExecuteStep( zString, nPos + 1, oFinalContinuation );
          }
          
          oNextContinuation = function() {  /* This will be scheduled to run at the next step */
            ExecuteStep( a, 0, oReturnContinuation );
          }
          
          /* Update the UI to show the new function */
          g_zActiveFunction = a;
          g_nActivePosition = 0;
          bUIUpdated = true;
          break;
        }
        case ":":
        {
          /* Set variable */
          a = Stack.popString();
          b = Stack.popVar();
          
          Storage.setData( a, b );
          break;
        }
        case ";":
        {
          /* Retrieve variable */
          a = Stack.popString();
          
          b = Storage.getData( a );
          
          Stack.pushVar( b );
          break;
        }
        case "?":
        {
          /* If */
          a = Stack.popFunction();
          b = Stack.popBool();
          
          if( b ) {
            oReturnContinuation = function() {
              ExecuteStep( zString, nPos + 1, oFinalContinuation );
            }
          
            oNextContinuation = function() {  /* This will be scheduled to run at the next step */
              ExecuteStep( a, 0, oReturnContinuation );
            }
            /* Update the UI to show the new function */
            g_zActiveFunction = a;
            g_nActivePosition = 0;
            bUIUpdated = true;
          }
          break;
        }
        case "#":
        {
          /* While loop */
          a = Stack.popFunction();
          b = Stack.popFunction();
          
          /* The following is a continuation-style way of saying:
            while( Execute( b ), c = Stack.popBool(), c ) { Execute( a ); }
          */
          
          oReturnContinuation = function() {
            ExecuteStep( zString, nPos + 1, oFinalContinuation );
          }
          
          let oConditionalContinuation = function() {
            let c = Stack.popBool();
            
            if( c ) {
              ExecuteStep( a, 0, oNextContinuation );   /* Note the advance use of oNextConditional. When this is executed, oNextConditional will be bound to the function defined below. */
            } else {
              oReturnContinuation();  /* Continue executing current function */
            }
          }

          oNextContinuation = function() {  /* This will be scheduled to run at the next step */
            ExecuteStep( b, 0, oConditionalContinuation );
          }
          /* Update the UI to show the new function */
          g_zActiveFunction = b;
          g_nActivePosition = 0;
          bUIUpdated = true;
          break;
        }
        case ".":
        {
          /* Output an integer */
          a = Stack.popInt();

          Output( a );
          
          break;
        }
        case ",":
        {
          /* Output a character */
          a = Stack.popInt();
          if( a < 0n || a > 65535n) {
            throw( new Error( "Parameter " + a + " out of range for opcode ','!" ) );
            /* Actually, Javascript happily converts negative numbers to chars. Could omit this test. */
          }
          
          Output( String.fromCharCode( Number( a ) ) );
          
          break;
        }
        case "^":
        {
          /* Input a character */
          a = Input();
          
          Stack.pushInt( a );
          
          break;
        }
        case "ß":
        {
          /* Flush I/O */
          /* Unimplemented here but handled for compatibility */
          debug( 0, "Opcode 'ß' (flush I/O) ignored (unimplemented)" );
          break;
        }
        case "`":
        {
          /* Breakpoint for debugging */
          debug( 1, "** BREAKPOINT **" );
          UpdateStatusMessage( "Breakpoint encountered, paused." );
          Pause();
          break;
        }
        case "]":
        case "}":
        {
          /* Found unbalanced ']'! */
          debug( 0, "Unbalanced '" + c + "' encountered! Ignoring it." );
          break;
        }
        case " ":
        case "\t":
        case "\n":
        case "\r":
          break;
        default:
        {
          debug( 0, "Encountered invalid character '" + c + "' in program! Ignoring it." );
          break;
        }
      }
      nLength = 1;
    }
  } catch( e ) {
    debug( 0, "Runtime error: " + e.message );
    UpdateStatusMessage( "Runtime error: " + e.message );
    Abort();
    return;
  }

  /* Update the UI */
  if( !bUIUpdated ) {
    g_zActiveFunction = zString;
    g_nActivePosition = nPos + nLength;
  }
  UpdateUI();
  
  /* Set up the continuation for the next step */
  if( oNextContinuation == null )
  {
    oNextContinuation = function() {
      ExecuteStep( zString, nPos + nLength, oFinalContinuation );
    }
    debug( 5, "ExecuteStep(): setting oNextContinuation to ExecuteStep( '" + zString + "', " + (nPos +nLength) + ", _ )" );
  }
  
  g_oCurrentContinuation = oNextContinuation;
}

function ParseChar( zString )
{
  if( zString.length < 2 ) {
    throw( new Error( "Literal character missing after ' opcode! End of input reached." ) );
  }
  
  Stack.pushInt( zString.charCodeAt( 1 ) );
  
  return( 2 );
}

function ParseNumber( zString )
{
  let zDigits = zString.match( /^[0-9]+/ )[0];
  
  let a = BigInt( zDigits );
  debug( 8, "ParseNumber( '" + zString + "' ): matched '" + zDigits + "', parsed " + a + ", returning '" +zString.substring( zDigits.length ) + "'" );
  Stack.pushInt( a );
  
  return( zDigits.length );
}

function ParseName( zString )
{
  let zName = zString.match( /^[a-zA-Z]+/ )[0];

  debug( 8, "ParseName( '" + zString + "' ): matched '" + zName + "', returning '" +zString.substring( zName.length ) + "'" );
  
  Stack.pushString( zName );
  
  return( zName.length );
}

function ParseString( zString )
{
  /* TODO: support escapes */
  let zQuote = zString.match( /^\"[^\"]*\"/ )[0];
  /* TODO: if no closing quote, throw exception */
  let zText = zQuote.substring( 1, zQuote.length - 1 );

  debug( 8, "ParseString( '" + zString + "' ): matched '" + zQuote + "', parsed " + zText + ", returning '" +zString.substring( zQuote.length ) + "'" );
  
  Output( zText );
  
  return( zQuote.length );
}

function ParseComment( zString )
{
  let nLength = 0;
  let nDepth = 0;
  do {
//    debug( 6, "ParseComment( '" + zString + "' ) depth: " + nDepth + " length: " + nLength + " zString[nLength]: " + zString[nLength] );
    if( nLength >= zString.length ) {
      /* Unbalanced braces, throw exception */
      throw( new Error( "Unbalanced braces! Reached end of input while parsing comments.") );
    }
    if( zString.charAt( nLength ) == "{" ) nDepth++;
    else if( zString.charAt( nLength ) == "}" ) nDepth--;
    nLength++;
  } while( nDepth != 0 );
  
  debug( 8, "ParseComment( '" + zString + "' ): matched '" + zString.substring( 0, nLength ) + "', returning '" +zString.substring( nLength ) + "'" );
  
  return( nLength );
}

function ParseFunction( zString )
{
  let nLength = 0;
  let nDepth = 0;
  do {
    if( nLength >= zString.length ) {
      /* Unbalanced brackets, throw exception */
      throw( new Error( "Unbalanced brackets! Reached end of input while parsing function.") );
    }
    if( zString.charAt( nLength ) == "[" ) {
      nDepth++;
      nLength++;
    }
    else if( zString.charAt( nLength ) == "]" ) {
      nDepth--;
      nLength++;
    }
    else if( zString.charAt( nLength ) == "{" ) {
      nLength += ParseComment( zString.substring( nLength ) );
    }
    else {
      nLength++;
    }
  } while( nDepth != 0 );

  let zCode = zString.substring( 1, nLength - 1 ); /* Extract the program code, not including opening/closing [] */
  
  debug( 8, "ParseFunction() parsed '" + zCode + "'" );
  
//  Stack.pushFunction( zCode + " " );  /* HACK: the extra space is to make the gui behave better. */
  Stack.pushFunction( zCode );
  
  return( nLength );
}

function Output( msg )
{
    g_zOutput += msg;
}

function Input()
{
  if( g_zInputBuf == "" || g_zInputBuf == null ) {
    g_zInputBuf = prompt();
  }

  if( g_zInputBuf != "" && g_zInputBuf != null )
  {
    let c = g_zInputBuf.charCodeAt( 0 );
    g_zInputBuf = g_zInputBuf.substring( 1 );
    return( c );
  }
  else
  {
    return( -1 );
  }
}

/* UpdateUI: display the stack, storage and active function in the display area */
function UpdateUI()
{
  let oNode = document.getElementById( "MachineStatusStack" );
  while( oNode.hasChildNodes() ) oNode.removeChild( oNode.firstChild );
  
  let oTmp = document.createElement( "pre" );
  oTmp.appendChild( document.createTextNode( Stack.dump() ) );
  oNode.appendChild( oTmp );
  
  oNode = document.getElementById( "MachineStatusStorage");
  while( oNode.hasChildNodes() ) oNode.removeChild( oNode.firstChild );
  
  oTmp = document.createElement( "pre" );
  oTmp.appendChild( document.createTextNode( Storage.dump() ) );
  oNode.appendChild( oTmp );
  
  oNode = document.getElementById( "MachineStatusProgram" );
  while( oNode.hasChildNodes() ) oNode.removeChild( oNode.firstChild );
  oTmp = document.createElement( "pre" );
  oTmp.id = "MachineStatusProgramBefore";
  oTmp.appendChild( document.createTextNode( g_zActiveFunction.substring( 0, g_nActivePosition ) ) );
  oNode.appendChild( oTmp );
  oTmp = document.createElement( "pre" );
  oTmp.id = "MachineStatusProgramCurrent";
  oTmp.appendChild( document.createTextNode( g_zActiveFunction.substring( g_nActivePosition, g_nActivePosition + 1 ) ) );
  oNode.appendChild( oTmp );
  oTmp = document.createElement( "pre" );
  oTmp.id = "MachineStatusProgramAfter";
  oTmp.appendChild( document.createTextNode( g_zActiveFunction.substring( g_nActivePosition + 1 ) ) );
  oNode.appendChild( oTmp );

  oNode = document.getElementById( "MachineStatusOutput" );
  while( oNode.hasChildNodes() ) oNode.removeChild( oNode.firstChild );
  oNode.appendChild( document.createTextNode( g_zOutput ) );
}

/* UpdateStatusMessage( sString ): display sString in the status message area */
function UpdateStatusMessage( sString )
{
  let oTmp = document.getElementById( "MachineStatusMessagesContainer" );
	while( oTmp.hasChildNodes() ) oTmp.removeChild( oTmp.firstChild );
	
	oTmp.appendChild( document.createTextNode( sString ) );
}

function debug( n, str ) {
	if( n <= 0 ) {
		UpdateStatusMessage( str );
	}
	if( g_nDebugLevel >= n  ) {
		let oDebug = document.getElementById( "debug" );
		if( oDebug ) {
			let oNode = document.createElement( 'pre' );
			oNode.appendChild( document.createTextNode( str ) );
			oDebug.appendChild( oNode );
		}
	}
}

function ClearDebug() {
	let oDebug = document.getElementById( "debug" );
	while( oDebug.hasChildNodes() ) {
		oDebug.removeChild( oDebug.firstChild );
	}
}

/* Finished: called when the program terminates. */
function Finished()
{
  Pause();
  UpdateUI();
  let nNow = document.timeline.currentTime;
  UpdateStatusMessage( "Finished in " + g_nStepCount + " steps, " + Math.round(nNow - g_nStartTime) + " milliseconds." );
  g_oCurrentContinuation = function() {};
  
  document.getElementById( "RunButton" ).disabled = true;
  document.getElementById( "StepButton" ).disabled = true;
  document.getElementById( "PauseButton" ).disabled = true;
  document.getElementById( "ResetButton" ).disabled = false;
}

/* Abort: called when the program is terminated due to a runtime error */
function Abort()
{
  Pause();
  g_oCurrentContinuation = function() {};

  document.getElementById( "RunButton" ).disabled = true;
  document.getElementById( "StepButton" ).disabled = true;
  document.getElementById( "PauseButton" ).disabled = true;
  document.getElementById( "ResetButton" ).disabled = false;
}

function Reset()
{
  if( g_oTimer ) {
    clearInterval( g_oTimer );
    g_oTimer = null;
  }
  g_oCurrentContinuation = null;
  Stack.clear();
  Storage.clear();
  g_zInputBuf = "";
  g_zOutput = "";
  g_zActiveFunction = "";
  g_nActivePosition = 0;
  g_nStepCount = 0;
  g_nStartTime = 0;
  UpdateUI();
}

function Step()
{
  if( g_oCurrentContinuation == null ) {
    /* Hasn't started running yet. Set up the initial continuation. */
    debug( 2, "Warning: Step() called while current continuation is null!" );

    let zProgram = document.getElementById( "ProgramSource" ).value;

    function c() {
      ExecuteStep( zProgram, 0, Finished );
    }

    g_oCurrentContinuation = c;
    /* Use new fangled tech */
    g_nStartTime = document.timeline.currentTime;
  }
  
  if( g_bTurbo && g_bRunning) {
    /* Do 30 steps at a time in turbo mode */
    for( let i = 0; i < 30; i++ ) {
      g_oCurrentContinuation();
      if( !g_bRunning ) break;      /* Hit a breakpoint or program terminated */
    }
  }
  else {
    /* Do a single step in slow mode */
    g_oCurrentContinuation();
  }
}

/* Trigger functions for the buttons */

function ResetButtonPressed()
{
  Reset();
  UpdateStatusMessage( "Reset." );
  document.getElementById( "RunButton" ).disabled = false;
  document.getElementById( "StepButton" ).disabled = false;
  document.getElementById( "PauseButton" ).disabled = true;
  document.getElementById( "ResetButton" ).disabled = false;
}

function Run()
{
  if( g_oTimer != null ) {
    debug( 2, "Warning: Run() called while g_oTimer != null!" );
    return;
  }
  g_bRunning = true;
  UpdateStatusMessage( "Running..." );
  TurboCheckboxPressed(); /* Make sure that we're got the right speed set */
  document.getElementById( "RunButton" ).disabled = true;
  document.getElementById( "StepButton" ).disabled = true;
  document.getElementById( "PauseButton" ).disabled = false;
  document.getElementById( "ResetButton" ).disabled = true;
  g_oTimer = setInterval( Step, g_nStepPeriod );
}

function Pause()
{
  if( g_oTimer != null ) {
    clearInterval( g_oTimer );
    g_oTimer = null;
  }
  
  g_bRunning = false;
  
  document.getElementById( "RunButton" ).disabled = false;
  document.getElementById( "StepButton" ).disabled = false;
  document.getElementById( "PauseButton" ).disabled = true;
  document.getElementById( "ResetButton" ).disabled = false;
}

function RunButtonPressed()
{
  Run();
}

function StepButtonPressed()
{
  Step();
}

function PauseButtonPressed()
{
  Pause();
  UpdateStatusMessage( "Paused." );
}

function TurboCheckboxPressed()
{
  g_bTurbo = document.getElementById( "TurboCheckbox" ).checked;
  if( g_bTurbo ) {
    g_nStepPeriod = 1;
  } else {
    g_nStepPeriod = 100;
  }
  debug( 4, "TurboCheckboxPressed(): set period to " + g_nStepPeriod );
}

function LoadProgram( zName, bResetWhenLoaded )
{
	debug( 2, "Load '" + zName + "'" );
	var zFileName = zName + ".txt";
	
	try {
    var oRequest = new XMLHttpRequest();
    oRequest.onreadystatechange = function()
    {
      if( oRequest.readyState == 4 ) {
        document.getElementById( "ProgramSource" ).value = oRequest.responseText;
        
        /* Reset the machine to load the new program, etc, if required */
        /* This is necessary only when loading the default program for the first time */
        if( bResetWhenLoaded ) {
          Reset();
        }
      }
    };
    
    oRequest.open( "GET", zFileName, true );
    oRequest.send( null );
  } catch( e ) {
    debug( 2, "LoadProgram(): caught exception! " + e.message );
    UpdateStatusMessage( "Error loading program '" + zName + "'!" );
  }
}

function CycleDebugLevel()
{
  g_nDebugLevel = (g_nDebugLevel + 1) % 10;
  debug( 1, "Debug level now " + g_nDebugLevel );
}


/** Some util functions **/

function isalpha( c )
{
  return( /^[a-zA-Z]+$/.test( c ) );
  /* return( c.search( /^[a-zA-Z]+$/ ) == 0 ); */
}


function isdigit( c )
{
  return( /^[0-9]+$/.test( c ) );
  /* return( c.search( /^[0-9]+$/ ) == 0 ); */
}

function isalnum( c )
{
  return( /^[a-zA-Z0-9]+$/.test( c ) );
  /* return( c.search( /^[a-zA-Z0-9]+$/ ) == 0 ); */
}

/** End util functions **/
