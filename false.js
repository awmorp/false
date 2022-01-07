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


var g_nDebugLevel = 1;

/* Current continuation and step timer */

var g_oTimer = null;
var g_nStepPeriod = 100;  /* milliseconds between steps */
var g_oCurrentContinuation = null;

var g_bTurbo = false;
var g_bRunning = true;

var g_nStepCount = 0;
var g_nStartTime = 0;

/* UI helper global variables */

var g_zActiveFunction = "";
var g_nActivePosition = 0;

/* Input buffer */

var g_zInputBuf = "";

/* Output */
var g_zOutput = "";

/** Storage object **/

var Storage = {
  aData: new Object,
  
  clear: function()
  {
    this.aData = new Object;
  },
  
  getData: function( zName )
  {
    var z = this.aData[ zName ];
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
    var str = "";
    var bFirst = true;
    for( x in this.aData ) {
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

var Stack = {
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
    var a = new Object;
    a.value = x;
    a.type = "int";
    this.aData.push( a );
  },
  
  pushBool : function( x )
  {
    var a = new Object;
    a.value = x;
    a.type = "bool";
    this.aData.push( a );
  },
  
  pushString : function( x )
  {
    var a = new Object;
    a.value = x;
    a.type = "string";
    this.aData.push( a );
  },
  
  pushFunction : function( x )
  {
    var a = new Object;
    a.value = x;
    a.type = "function";
    this.aData.push( a );
  },
  
  popInt : function()
  {
    var a = this.popVar();
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
    var a = this.popVar();
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
    var a = this.popVar();
    if( a.type != "string" ) {
      this.pushVar( a );
      throw( new Error( "Type error: popString tried to pop a " + a.type + "!" ) );
    } else {
      return( a.value );
    }
  },
  
  popFunction : function()
  {
    var a = this.popVar();
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
    var str = "";
    var bFirst = true;
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

  var oNextContinuation = null;
  
  var zActiveString = zString.substr( nPos );
  var c = zActiveString.charAt( 0 );
  
  var nLength = 0;
  var bUIUpdated = false;
  
  try {
    if( isdigit( c ) )
    {
      nLength = ParseNumber( zActiveString );
    }
    else if( isalpha( c ) )
    {
      nLength = ParseName( zActiveString );
    }
    else if( c == "{" )
    {
      nLength = ParseComment( zActiveString );
    }
    else if( c == "[" )
    {
      nLength = ParseFunction( zActiveString );
    }
    else if( c == "\"" )  /* double-quote */
    {
      nLength = ParseString( zActiveString );
    }
    else if( c == "'" )  /* literal character */
    {
      nLength = ParseChar( zActiveString );
    }
    else {
      switch( c )   /* Handle single-char opcodes */
      {
        case "+":
        {
          /* Integer addition */
          var a = Stack.popInt();
          var b = Stack.popInt();
          Stack.pushInt( a + b );
          break;
        }
        case "-":
        {
          /* Integer subtraction */
          var a = Stack.popInt();
          var b = Stack.popInt();
          Stack.pushInt( b - a );
          break;
        }
        case "_":
        {
          /* Unary integer negation */
          var a = Stack.popInt();
          a = -a;
          Stack.pushInt( a );
          break;
        }
        case "*":
        {
          /* Integer multiplication */
          var a = Stack.popInt();
          var b = Stack.popInt();
          Stack.pushInt( a * b );
          break;
        }
        case "/":
        {
          /* Integer division */
          var a = Stack.popInt();
          var b = Stack.popInt();
          if( a == 0 ) {
            throw( new Error( "Attempt to divide by zero!" ) );
          }
          Stack.pushInt( (b - (b % a)) / a ); /* Javascript doesn't provide integer division so emulate it */
          break;
        }
        case "=":
        {
          /* Equality comparison */
          var a = Stack.popInt();
          var b = Stack.popInt();
          Stack.pushBool( a == b );
          break;
        }
        case ">":
        {
          /* Magnitude comparison */
          var a = Stack.popInt();
          var b = Stack.popInt();
          Stack.pushBool( b > a );
          break;
        }
        case "~":
        {
          /* Boolean negation */
          var a = Stack.popBool();
          Stack.pushBool( !a );
          break;
        }
        case "&":
        {
          /* Boolean and */
          var a = Stack.popBool();
          var b = Stack.popBool();
          Stack.pushBool( a && b );
          break;
        }
        case "|":
        {
          /* Boolean or */
          var a = Stack.popBool();
          var b = Stack.popBool();
          Stack.pushBool( a || b );
          break;
        }
        case "$":
        {
          /* Duplicate top of stack */
          var a = Stack.popVar();
          Stack.pushVar( a );
          Stack.pushVar( a );
          break;
        }
        case "%":
        {
          /* Delete top of stack */
          var a = Stack.popVar();
          break;
        }
        case "\\":
        {
          /* Swap top 2 stack elements */
          var a = Stack.popVar();
          var b = Stack.popVar();
          Stack.pushVar( a );
          Stack.pushVar( b );
          break;
        }
        case "@":
        {
          /* Rotate top 3 stack elements */
          var a = Stack.popVar();
          var b = Stack.popVar();
          var c = Stack.popVar();
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
          var a = Stack.popInt();
          if( a < 0 || a >= Stack.size() ) {
            throw( new Error( "Argument " + a + " out of range for pick opcode!" ) );
          }
          var b = Stack.getVar( a );
          Stack.pushVar( b );
          
          break;
        }
        case "®":
        {
            /* Rotate top n stack elements */
            /* Pops an integer n from the stack, then rotates the top n stack elements (not including n itself) */
            var n = Stack.popInt();
            if( n < 0 || n > Stack.size() ) {
              throw( new Error( "Argument " + n + " out of range for rotate n opcode!" ) );
            }
            if( n > 1 ) {   /* 'Rotate 0' or 'Rotate 1' has no effect, so do nothing in that case */
              var a = Stack.dropVar( n )[0];
              Stack.pushVar( a );
            }
            
            break;
        }
        case "!":
        {
          /* Apply function */
          var a = Stack.popFunction();
          
          var oReturnContinuation = function() {
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
          var a = Stack.popString();
          var b = Stack.popVar();
          
          Storage.setData( a, b );
          break;
        }
        case ";":
        {
          /* Retrieve variable */
          var a = Stack.popString();
          
          var b = Storage.getData( a );
          
          Stack.pushVar( b );
          break;
        }
        case "?":
        {
          /* If */
          var a = Stack.popFunction();
          var b = Stack.popBool();
          
          if( b ) {
            var oReturnContinuation = function() {
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
          var a = Stack.popFunction();
          var b = Stack.popFunction();
          
          /* The following is a continuation-style way of saying:
            while( Execute( b ), c = Stack.popBool(), c ) { Execute( a ); }
          */
          
          var oReturnContinuation = function() {
            ExecuteStep( zString, nPos + 1, oFinalContinuation );
          }
          
          var oConditionalContinuation = function() {
            var c = Stack.popBool();
            
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
          var a = Stack.popInt();

          Output( a );
          
          break;
        }
        case ",":
        {
          /* Output a character */
          var a = Stack.popInt();
          if( a < 0 ) {
            throw( new Error( "Parameter " + a + " out of range for opcode ','!" ) );
            /* Actually, Javascript happily converts negative numbers to chars. Could omit this test. */
          }
          
          Output( String.fromCharCode( a ) );
          
          break;
        }
        case "^":
        {
          /* Input a character */
          var a = Input();
          
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
  var zDigits = zString.match( /^[0-9]+/ )[0];
  
  var a = parseInt( zDigits );
  debug( 8, "ParseNumber( '" + zString + "' ): matched '" + zDigits + "', parsed " + a + ", returning '" +zString.substr( zDigits.length ) + "'" );
  Stack.pushInt( a );
  
  return( zDigits.length );
}

function ParseName( zString )
{
  var zName = zString.match( /^[a-zA-Z]+/ )[0];

  debug( 8, "ParseName( '" + zString + "' ): matched '" + zName + "', returning '" +zString.substr( zName.length ) + "'" );
  
  Stack.pushString( zName );
  
  return( zName.length );
}

function ParseString( zString )
{
  /* TODO: support escapes */
  var zQuote = zString.match( /^\"[^\"]*\"/ )[0];
  /* TODO: if no closing quote, throw exception */
  var zText = zQuote.substr( 1, zQuote.length - 2 );

  debug( 8, "ParseString( '" + zString + "' ): matched '" + zQuote + "', parsed " + zText + ", returning '" +zString.substr( zQuote.length ) + "'" );
  
  Output( zText );
  
  return( zQuote.length );
}

function ParseComment( zString )
{
  var nLength = 0;
  var nDepth = 0;
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
  
  debug( 8, "ParseComment( '" + zString + "' ): matched '" + zString.substr( 0, nLength ) + "', returning '" +zString.substr( nLength ) + "'" );
  
  return( nLength );
}

function ParseFunction( zString )
{
  var nLength = 0;
  var nDepth = 0;
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
      var nRemaining = ParseComment( zString.substr( nLength ) );
      nLength += nRemaining;
    }
    else {
      nLength++;
    }
  } while( nDepth != 0 );

  var zCode = zString.substr( 1, nLength - 2 ); /* Extract the program code, not including opening/closing [] */
  
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
    var c = g_zInputBuf.charCodeAt( 0 );
    g_zInputBuf = g_zInputBuf.substr( 1 );
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
  var oNode = document.getElementById( "MachineStatusStack" );
  while( oNode.hasChildNodes() ) oNode.removeChild( oNode.firstChild );
  
  var oTmp = document.createElement( "pre" );
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
  oTmp.appendChild( document.createTextNode( g_zActiveFunction.substr( g_nActivePosition, 1 ) ) );
  oNode.appendChild( oTmp );
  oTmp = document.createElement( "pre" );
  oTmp.id = "MachineStatusProgramAfter";
  oTmp.appendChild( document.createTextNode( g_zActiveFunction.substr( g_nActivePosition + 1 ) ) );
  oNode.appendChild( oTmp );

  oNode = document.getElementById( "MachineStatusOutput" );
  while( oNode.hasChildNodes() ) oNode.removeChild( oNode.firstChild );
  oNode.appendChild( document.createTextNode( g_zOutput ) );
}

/* UpdateStatusMessage( sString ): display sString in the status message area */
function UpdateStatusMessage( sString )
{
	oTmp = document.getElementById( "MachineStatusMessagesContainer" );
	while( oTmp.hasChildNodes() ) oTmp.removeChild( oTmp.firstChild );
	
	oTmp.appendChild( document.createTextNode( sString ) );
}

function debug( n, str ) {
	if( n <= 0 ) {
		UpdateStatusMessage( str );
	}
	if( g_nDebugLevel >= n  ) {
		var oDebug = document.getElementById( "debug" );
		if( oDebug ) {
			var oNode = document.createElement( 'pre' );
			oNode.appendChild( document.createTextNode( str ) );
			oDebug.appendChild( oNode );
		}
	}
}

function ClearDebug() {
	var oDebug = document.getElementById( "debug" );
	while( oDebug.hasChildNodes() ) {
		oDebug.removeChild( oDebug.firstChild );
	}
}

/* Finished: called when the program terminates. */
function Finished()
{
  Pause();
  UpdateUI();
  var d = new Date;
  var nNow = d.getTime();
  UpdateStatusMessage( "Finished in " + g_nStepCount + " steps, " + (nNow - g_nStartTime) + " milliseconds." );
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

    var zProgram = document.getElementById( "ProgramSource" ).value;

    function c() {
      ExecuteStep( zProgram, 0, Finished );
    }

    g_oCurrentContinuation = c;
    
    var d = new Date;
    g_nStartTime = d.getTime();
  }
  
  if( g_bTurbo && g_bRunning) {
    /* Do 20 steps at a time in turbo mode */
    for( var i = 0; i < 30; i++ ) {
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

function x()
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
