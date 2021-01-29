global.__basedir = __dirname;

var mqtt = require('mqtt')
var config = require('../data/appConfig.json');
var EventEmitter = require('events'); 
const fs = require('fs');
const Sensor = require('node-hue-api/lib/model/sensors/Sensor');

var client  = mqtt.connect(config.mqttServer)

client.on('connect', function () {
  client.subscribe(`${config.mqttBaseTopic}/+/#`, function () {
    console.log(`Subscribing to all ${config.mqttBaseTopic} topics`)
  })
  client.subscribe(`lights/hue/00:17:88:01:10:55:18:d4-0b/get/#`, function () {
    console.log(`Subscribing to all hue topic`)
  })
  client.subscribe(`homekitOverrides/+/set`, function () {
    console.log(`Subscribing to homekitOverrides topics`)
  })
})

client.on('message', function (topic, message) {

  let switchMatch = topic.match("shellies/[.*]/input/0")
  let i3match = topic.match("shellies/(.*)/input_event/(.*)")
  let homekitOverrideMatch = topic.match("homekitOverrides/(.*)/set")

  // if switch sends a command
  if ( switchMatch ) {
    console.log(switchMatch[1])
    shouldSwitchTriggerAction("0",message)
  }

  if ( i3match ) {
    let switchID = i3match[1]
    let inputNumber = i3match[2]
    let event = JSON.parse(message.toString())
    updateshadowState(switchID, inputNumber, event)
  }
  
  if ( homekitOverrideMatch ) {
    receivedHomekitOverride(homekitOverrideMatch[1],message.toString(),Date.now())
  }

})


const getShadowSwitchesIndex = (id) => {
  const objIndex = shadowSwitches.findIndex((theSwitch => theSwitch.id === id));
  return objIndex
}

const shouldSwitchTriggerAction = (id,payload) => {
  const objIndex = getShadowSwitchesIndex(id);
  let state = payload.toString()

  if ( objIndex !== -1 ) { // if object already exists. Update it's state
    if ( shadowSwitches[objIndex].state !== state ) { // check if the state is the same
      shadowSwitches[objIndex].state = state // if it's not the same, update the state and trigger a toggle
      switchTrigger.emit("toggle",{id});
    }
  } else {
    switchTrigger.emit("toggle",{id}); // if it doesn't exist, trigger the toggle
    shadowSwitches.push({ // and add the new object to the array
      "id": id,
      "state": state
    })
  }

}

// set up event listener for when the switch state is changed (e.g. toggled)
const switchTrigger = new EventEmitter();
switchTrigger.on('toggle', (event) => switchStateChanged(event) ); // Register for eventOne

function switchStateChanged(event) {
    toggleLight(event.id)
  //  console.log(`the switch ${event.id} was toggled`)
}

const toggleLight = (id) => {
  let lights = getLightsAssociatedToSwitch(id)
  lights.forEach( (light) => {
    getLightStatus(light)
  })
}

const getLightsAssociatedToSwitch = (id) => {
  const objIndex = switchConfigMap.findIndex((theSwitch => theSwitch.switchID === +id));
  const allLights = switchConfigMap[objIndex].lights
  return allLights
}

const getLightStatus = (id) => {
  const objIndex = getShadowLightIndex(id)
  const isLightOn = shadowLights[objIndex].on

  if ( isLightOn ) {
    // console.log("TURNING LIGHT OFF")
    client.publish(
      `lights/hue/00:17:88:01:10:55:18:d4-0b/set/on`, `false`
    ) 
  } else {
    // console.log("TURNING LIGHT ON")
    client.publish(
      `lights/hue/00:17:88:01:10:55:18:d4-0b/set/on`, `true`
    ) 
    client.publish(
      `lights/hue/00:17:88:01:10:55:18:d4-0b/set/brightness`, shadowLights[objIndex].brightness > 0 ? `${convertTo255(shadowLights[objIndex].brightness)}` : `${convertTo255(100)}`
    ) 
  }
}

const convertTo255 = (percentage) => {
  return (255 * (percentage/100)).toFixed(0)
}



const runOnStartup = () => {
  shadowRoomSync() // goes through the configured rooms and makes sure they're in the state, this should also copy across any existing state if room is already in the shadow state.
}


// I3 SCRIPTS



const updateshadowState = (switchID, inputNumber, payload) => {
  let shadowState = getShadowState()
  let room = whichRoomIsSwitchIn(switchID)
  let allSwitchesInRoom = shadowState.rooms.find( eachRoom => eachRoom.title === room ).switches
  let allInputsForSwitch = allSwitchesInRoom.find( eachSwitch => eachSwitch.title === switchID).inputs
  let theInput = allInputsForSwitch.find(input => input.inputNumber === inputNumber )
  if ( theInput ) {
    let theNewState = calculateSwitchState(switchID, inputNumber, theInput, payload)
    if ( theNewState ) {  // theNewState could return false if the event_count is duplicated
      theInput.state = theNewState.state
      theInput.previousCount = theNewState.updatedCount
      if ( typeof theNewState.cachedState === "number" ) {
        theInput.cachedState = theNewState.cachedState
      }
      theInput.updated = theNewState.updated
      
      const resetRoomID = resetOverride(switchID)
      shadowState.rooms[resetRoomID].override = {}
    }
  } else {
    // console.log(`dont' recognise this input ${inputNumber}. Needs to be registered in lightsRooms.json`)
  }
  fs.writeFileSync('./data/state/shadowState.json', JSON.stringify(shadowState,null,2));
}

const getShadowState = () => {
  return JSON.parse(fs.readFileSync('./data/state/shadowState.json', 'utf8'))
}

const shadowRoomSync = () => {
  let shadowState = getShadowState()
  if ( shadowState.rooms === undefined) {
    // the rooms array doesn't exist. So make it
    shadowState.rooms = []
    fs.writeFileSync('./data/state/shadowState.json', JSON.stringify(shadowState,null,2));
    shadowRoomSync() // rerun
  }

  let allRegisteredRooms = JSON.parse(fs.readFileSync('./data/config/lightsRooms.json', 'utf8')).rooms
  allRegisteredRooms.forEach((room)=> {
    let roomIndexInShadow = shadowState.rooms.findIndex( (eachRoom) => eachRoom.title === room.title)
    console.log(roomIndexInShadow)
    if ( roomIndexInShadow === -1 ) {
      shadowState.rooms.push({
        "title": room.title
      })
      fs.writeFileSync('./data/state/shadowState.json', JSON.stringify(shadowState,null,2));
      shadowRoomSync() // rerun
    } else {
      const roomObj = shadowState.rooms[roomIndexInShadow]
      roomObj.title     = roomObj.title || room.title // this should never be needed but in here for good measure
      roomObj.override  = roomObj.override || { type: null, timestamp: null} // if an override has already been set, use that, if not, use null
      roomObj.switches  = getLightSwitches(room.title, roomObj)
      fs.writeFileSync('./data/state/shadowState.json', JSON.stringify(shadowState,null,2));
    }
  })
}

const getLightSwitches = (roomTitle, shadowRoomState) => {
  let roomSwitches = JSON.parse(fs.readFileSync('./data/config/lightsRooms.json', 'utf8')).rooms.find((room)=>room.title === roomTitle).switches
  
  let switchArray

  let existingSwitches = shadowRoomState.switches

  if ( existingSwitches === undefined ) {
    switchArray = []
  } else {
    switchArray = existingSwitches
  }

  roomSwitches.forEach((eachSwitch) => {
    let switchIndex = switchArray.findIndex((eachExistingSwitch) => eachExistingSwitch.title === eachSwitch.title)
    if ( switchIndex === -1 ) {
      // if switchArray can't find a switch with the same title... add it
      switchArray.push({
        "title": eachSwitch.title,
        "inputs": getTriggers(eachSwitch.inputs,switchArray[switchIndex])
      })
    } else {
      switchArray[switchIndex].inputs = getTriggers(eachSwitch.inputs,switchArray[switchIndex])
    }
  })
  return switchArray
}

const getTriggers = (registeredTriggers,switchShadow) => {
  console.log(registeredTriggers)

  let shadowTrigger = switchShadow.inputs ? switchShadow.inputs : []
  
  
  let triggerArray = []
  registeredTriggers.forEach( (trigger) => {

    let existingShadowIndex = shadowTrigger.findIndex( shadowTrigger => shadowTrigger.inputNumber === trigger.inputNumber )
    let existingState = 0
    let existingCount = null
    let cachedState
    // let updated
    if ( existingShadowIndex !== -1) {
      existingState = shadowTrigger[existingShadowIndex].state || 0 // if state is found, use that (if state isn't valid then use 0 as backup)
      existingCount = shadowTrigger[existingShadowIndex].previousCount || null // if previousCount is found, use that (if state isn't valid then use 0 as backup)
      cachedState = shadowTrigger[existingShadowIndex].cachedState || false
      // updated = shadowTrigger[existingShadowIndex].updated || null
    }
    triggerArray.push({
      "inputNumber": trigger.inputNumber,
      "state": existingState,
      "previousCount": existingCount
      // "updated": updated,
    })
    if ( cachedState ) { // probably a bit overkill for such an edge case but if the cached state already exists then may aswell push that too
      triggerArray[0].cachedState = cachedState
    }
  })
  return triggerArray
}



const calculateSwitchState = (switchID, inputNumber, existing, payload) => {

  if ( existing.previousCount === payload.event_cnt) { 
    return false // is repeated state. Don't update
  }

  const shadowState = getShadowState()
  const room = whichRoomIsSwitchIn(switchID)
  const override = shadowState.rooms.find( eachRoom => eachRoom.title === room ).override.type

  const oldState = existing.state
  const event = payload.event
  let stateTotal = getStateTotalCount(switchID,inputNumber)
  let newState

  switch ( event ) {
    case "S":
      if ( override === "on" ) {
        newState = 0
      } else if ( override === "off") {
        newState = existing.state || 1
      } else {
        if ( oldState === 0) {
          newState = existing.cachedState || 1
        } else {
          newState = 0
        }
      }
      break;
    case "SS":
      if ( override === "off" ) {
        newState = oldState
      } else {
        newState = oldState + 1 > stateTotal ? 1 : oldState + 1
      }
      break;
    default:
      newState = 0
      break;
  }

  sendStateCommand(switchID, inputNumber, newState)
  return {"state": newState, "cachedState": oldState, "updatedCount": payload.event_cnt, "updated": Date.now()}
}
  
const resetOverride = (switchID) => {
  console.log("RESET")
  const room = whichRoomIsSwitchIn(switchID)
  let shadowState = getShadowState()
  let allRooms = shadowState.rooms
  let theRoomIndex = allRooms.findIndex( eachRoom => eachRoom.title === room)
  return theRoomIndex
}

const getStateTotalCount = (switchID,inputNumber) => {
  const room = whichRoomIsSwitchIn(switchID)
  const allSwitches = JSON.parse(fs.readFileSync('./data/config/lightsRooms.json')).rooms.find( eachRoom => eachRoom.title === room ).switches
  const allInputs = allSwitches.find( eachSwitch => eachSwitch.title === switchID).inputs
  const theStateTotal = allInputs.find( eachInput => eachInput.inputNumber === inputNumber).stateTotal || 1
  return theStateTotal
}

const whichRoomIsSwitchIn = (switchID) => {
  let allRooms = JSON.parse(fs.readFileSync('./data/config/lightsRooms.json'))
  allRooms = Object.values(allRooms.rooms)
  for (var i = 0; i < allRooms.length; i++) {
    let switches = allRooms[i].switches
    for (var i = 0; i < switches.length; i++) {
      if ( switches[i].title === switchID) {
        return allRooms[i].title
      } else {
        console.log(`no match`)
      }
    }
  }
}

const getSwitchesForRoom = (room) => {
  let allRooms = JSON.parse(fs.readFileSync('./data/config/lightsRooms.json')).rooms
  const allSwitchesForRoom = allRooms.find( eachRoom => eachRoom.title === room).switches
  return allSwitchesForRoom
}

const getInputsForSwitch = (allSwitches,switchID) => {
  let theInputs = allSwitches.find( eachSwitch => eachSwitch.title === switchID ).inputs
  if ( theInputs ) {
    return theInputs
  } else 
    console.log(`a switch with the id ${switchID} has not yet been registered. Add to lightsRooms.json`)
    return false
}

const sendStateCommand = (switchID, inputNumber, newState) => {
  // when the number of states is over 2 (+ the first state === 3) multiple homekit switches are needed. This divides up the payload to add a group which equates to one of those homekit switches
  const baseTopic = getSwitchTopic(switchID, inputNumber, newState)
  if ( baseTopic ) {
    let payload = calculatePayload(newState)
    let topic = `${baseTopic}/${payload.group}`
    console.log(`Sending "${payload.value}" value to: ${topic}`)
    client.publish(
      `${topic}`, `${payload.value}`
    ) 
  } else {
    console.error(`No topic found for ${switchID}:${inputNumber}`)
  }
}

const calculatePayload = (state) => {
  let group = Math.floor(+state/3)
  let value = state - (group * 3)
  return {group,value}
}

const getSwitchTopic = (switchID, inputNumber, state) => {
  const room = whichRoomIsSwitchIn(switchID)
  const allSwitches = getSwitchesForRoom(room)
  const allInputs = getInputsForSwitch(allSwitches,switchID)
  const theTopic = allInputs.find(input => input.inputNumber === inputNumber).topic
  return theTopic
}

const receivedHomekitOverride = (id,message,timestamp) => {
  const override = whichRoomIsOverrideIn(id)
  const room = override.room
  const overrideType = override.overrideType
  const payload = message === 'true' ? true : false
  const mostRecentlyUpdatedTimestamp = getMostRecentTimestamp(room)
  const timeDiff = timestamp-mostRecentlyUpdatedTimestamp
  if ( timeDiff > 1500) { // if most recent timestamp was less than x ms ago, assume this command was from the switch so is not an override
    setOverrideValue(room,overrideType,payload,timestamp)
  }
  
}

const getMostRecentTimestamp = (room) => {
  let shadowState = getShadowState()
  let allSwitchesInRoom = shadowState.rooms.find( eachRoom => eachRoom.title === room ).switches
  let timestampArray = []
  allSwitchesInRoom.forEach( (eachSwitch) => {
    eachSwitch.inputs.forEach((input) => {
      input.updated && timestampArray.push(input.updated)
    })
  })
  return Math.max(...timestampArray)
}

const whichRoomIsOverrideIn = (topicID) => {
  let allRooms = JSON.parse(fs.readFileSync('./data/config/lightsRooms.json')).rooms
  for (var i = 0; i < allRooms.length; i++) {
    let theRoom = allRooms[i]
    if ( theRoom.homekitOverrideTopic.off === topicID ) { return {"overrideType":"off","room":theRoom.title} }
    if ( theRoom.homekitOverrideTopic.on === topicID )  { return {"overrideType":"on","room":theRoom.title} }
  }
}

const setOverrideValue = (room,overrideType,payload,timestamp) => {
  let shadowState = getShadowState()
  let allRooms = shadowState.rooms
  if ( allRooms ) {
    let overrideObj = allRooms.find(eachRoom => eachRoom.title === room).override
    if ( payload ) { // payload is either true or false
      overrideObj.type = overrideType
      overrideObj.timestamp = timestamp
    }
  }
  writeToShadow(shadowState)
}

runOnStartup();

const writeToShadow = (content) => {
  console.log(content)
  try {
    fs.writeFileSync('./data/state/shadowState.json', JSON.stringify(content,null,2));
    console.log("Completed writing to staaate")
  } catch (e) {
    console.error(e);
  }
}




// TO DO MOTION SENSOR
// IDEA: IF SWITCH STATE IS NOT 0, IE THE SWITCH HAS BEEN TOGGLED,
// CHANGE MOTION SENSOR TIMEOUT TO BE MAYBE 15 MINS
// IF SWITCH STATE IS 0, MAYBE MAKE IT 5 MINS?

// MAYBE ANOTHER IDAE: IF THE LONG PRESS IS HELD... RESET THE MOTION SENSOR TIMER TO 2 HOURS
// ANOTHER IDEA IF STATE IS 4 (e.g. film?) DON'T LISTEN TO MOTION SENSOR EVER