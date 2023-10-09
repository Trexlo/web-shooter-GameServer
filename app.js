
const http = require('http');
const server = http.createServer();
const { Server } = require("socket.io");
const THREE = require('three');
const { io } = require('socket.io-client');
const {  appendFileSync, readFile, readFileSync, writeFileSync } = require('fs');

var cfgFile = readFileSync('./config.json', {encoding:'ascii'});
var serverConfig = JSON.parse(cfgFile);
var playermodel = new THREE.Scene();
var model = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshStandardMaterial());
model.geometry.computeBoundingBox();
playermodel.add(model);
console.log(`loaded config ${JSON.stringify(serverConfig)}`);
const PORT = (serverConfig)? serverConfig.port : "5000";
const IP = (serverConfig)? serverConfig.ip : "localhost";
const MASTERPORT = (serverConfig)? serverConfig.masterServerPort : "3000";
const MASTERIP = (serverConfig)? serverConfig.masterServerIP : "localhost";

const SocketServer = new Server(server, {
  // @ts-ignore
  cors: true,
  origins:["https://*","https://*:*","http://*:*","http://*"],
  // allowRequest: (req, callback) => {
  //   const noOriginHeader = req.headers.origin === undefined;
  //   callback(null, true);
  // },
});
//connect client to master server
const SocketClient = io("wss://web-shooter-webserver.onrender.com",{
  query:{
    type:"server",
    port:PORT,
    ip:IP,
    overrideAddress:serverConfig.overrideAddress,
    usePort:serverConfig.usePort,
    secure:serverConfig.secure,
  },
});

var dirAngle = new THREE.Euler(THREE.MathUtils.degToRad(0),THREE.MathUtils.degToRad(45),THREE.MathUtils.degToRad(0), 'XYZ');
var direction = new THREE.Vector3(1,0,0);
direction.applyEuler(dirAngle);
var cameraOffset = new THREE.Vector3(1, 0, 0);
var angle = new THREE.Euler(THREE.MathUtils.degToRad(0), THREE.MathUtils.degToRad(45+180), THREE.MathUtils.degToRad(65), 'XYZ');
cameraOffset.applyEuler(angle).multiplyScalar(10);

var configuration = {
  direction: direction,
  cameraOffset: cameraOffset,
  sendingFrequency: serverConfig.configuration.sendingFrequency,
  //speed: 5,
}
var startConfig = serverConfig.startConfig;
// var startConfig={
//   //enemy
//   enemy:{  
//     maxHealth:8,
//     minHealth:3,
//     minSpeed:2,
//     maxSpeed:4,
//     minDamage:10,
//     maxDamage:35,
//   },
//   //player
//   player:{
//     ammo:90,
//     mag:30,
//     maxHealth:100,
//     speed:5,
//     damage:10,
//     magSize:30,
//     firerate:2/5,// second/attack
//     reloadingTime:0.8,// second
//   },
//   pickups:{
//     ammo:30,
//     health:50
//   }
// }
var upgrades = {
  speed:(s)=>     Math.trunc((s*1.025)*100)/100,
  firerate:(f)=>  Math.trunc((f/1.1)*100)/100,
  maxHealth:(h)=> h+30,
  magSize:(m)=>   m+10,
  damage:(d)=>    d+10,
}
//
var cachedMaps = [];

class Pickup{
  id;
  type;
  position;
  box;
  value;
  action;
  pickedUp;
  duration=30;
}

class HealthPickup extends Pickup{
  constructor(position){  
    super()
    this.id = THREE.MathUtils.generateUUID();
    this.type = "health";
    this.position = position;
    this.box = new THREE.Box3().setFromCenterAndSize(position, new THREE.Vector3(0.75,2,1.5));
    this.value = startConfig.pickups.health;
    this.action = (target)=>{if(this.pickedUp || target.health == target.attributes.maxHealth)return;   target.changeHP(startConfig.pickups.health); this.pickedUp=true;};
    this.pickedUp=false;
  }
}
class AmmoPickup extends Pickup{
  constructor(position){  
    super()
    this.id = THREE.MathUtils.generateUUID();
    this.type = "ammo";
    this.position = position;
    this.box = new THREE.Box3().setFromCenterAndSize(position, new THREE.Vector3(0.75,2,1.5));
    this.value = startConfig.pickups.ammo;
    this.action = (target)=>{if(this.pickedUp)return; target.addAmmo(startConfig.pickups.ammo); this.pickedUp=true;};
    this.pickedUp=false;
  }
}
var pathDiff = 0.2;//deviation in path
class Character{
  id;
  model;
  position=new THREE.Vector3();
  rotation=new THREE.Euler();
  currentNode;
  health;
  dead = false;
  attacking = false;
  attackTimer = new THREE.Clock();
  attackDelta = 0;
  changeHP(diff){
    this.health+=diff;
    this.dead = this.health<=0;
  }
}

class Enemy extends Character{
  constructor(model, game, spawnNode=null) {
    super()
    this.id = THREE.MathUtils.generateUUID()
    this.game = game;
    this.model = model.clone();
    this.model.traverse(function(object) {

      if ( object.isMesh ) {

        object.geometry = object.geometry.clone();

      }

    });
    if(spawnNode==null){//set spawn point
        var spawnPoint = game.nodes.filter(n => { //filter all nodes that are far away from all players (between 30 and 50 units radius)
          for(let p of game.players.values()){
            if(p.position.distanceTo(new THREE.Vector3(n.center.x, 0, n.center.z))<30 || p.position.distanceTo(new THREE.Vector3(n.center.x, 0, n.center.z))>50){
              return false;
          }
        }
        return true;
        
      });
      
      if(spawnPoint.length==0){//if no nodes available spawn away from players
        spawnPoint = game.nodes.filter(n => { 
          for(let p of game.players.values()){
            if(p.position.distanceTo(new THREE.Vector3(n.center.x, 0, n.center.z))<30){
              return false;
            }
          }
          return true;
          
        });
      }
      spawnNode = spawnPoint[Math.floor(Math.random() * spawnPoint.length)];
    }
    if(spawnNode == null){//no available spawn nodes - spawn in a random node
      spawnNode = game.nodes[Math.floor(Math.random() * game.nodes.length)];
    }
    //set position in spawn node
    this.position = new THREE.Vector3().random().multiply(new THREE.Vector3(spawnNode.x2-spawnNode.x1, 0, spawnNode.z2-spawnNode.z1)).add(new THREE.Vector3(spawnNode.box.min.x,0,spawnNode.box.min.z));
    // this.position = new THREE.Vector3(myNode.center.x, 0, myNode.center.z);
    this.currentNode = spawnNode;
    //this.game.enemies.filter(e=> e.currentNode.id == this.currentNode.id && e.target!=null)

    //diceroll attributes;
    var attrPoints = 100;
    var speed= THREE.MathUtils.clamp(Math.trunc((Math.random()*attrPoints)), 10, 60);
    var speedInc = (speed-10) / 50;
    attrPoints-=speed;
    var health= THREE.MathUtils.clamp(Math.trunc((Math.random()*attrPoints)), 10, 60);
    var healthInc =  (health-10) / 50;
    attrPoints-=health;
    var damageInc = (attrPoints-10) / 50;
    
    this.attributes.damage=Math.trunc(startConfig.enemy.minDamage+(startConfig.enemy.maxDamage-startConfig.enemy.minDamage)*damageInc);
    this.attributes.speed=startConfig.enemy.minSpeed+(startConfig.enemy.maxSpeed-startConfig.enemy.minSpeed)*speedInc;
    this.attributes.maxHealth=Math.trunc(startConfig.enemy.minHealth+(startConfig.enemy.maxHealth-startConfig.enemy.minHealth)*healthInc);


    this.attributes.size = new THREE.Vector3(1,2,1).multiplyScalar(1-0.25*speedInc);

    this.health = this.attributes.maxHealth * (game.enemyWave*5);
    this.model.geometry.boundingBox.setFromCenterAndSize(this.position, this.attributes.size);
    this.model.geometry.computeBoundingSphere();
    this.model.position.copy(this.position);
    this.seekTimer.start();
    this.seekTimer.elapsedTime=10;
  }
  generateInSameNode(){//creates another enemy in the same node
    var x = {...this};
    x.position = new THREE.Vector3().random().multiply(new THREE.Vector3(x.currentNode.x2-x.currentNode.x1, 0, x.currentNode.z2-x.currentNode.z1)).add(new THREE.Vector3(x.currentNode.box.min.x,0,x.currentNode.box.min.z));
    // this.position = new THREE.Vector3(myNode.center.x, 0, myNode.center.z);
    var attrPoints = 100;
    var speed= THREE.MathUtils.clamp(Math.trunc((Math.random()*attrPoints)), 10, 60);
    var speedInc = (speed-10) / 50;
    attrPoints-=speed;
    var health= THREE.MathUtils.clamp(Math.trunc((Math.random()*attrPoints)), 10, 60);
    var healthInc =  (health-10) / 50;
    attrPoints-=health;
    var damageInc = (attrPoints-10) / 50;
    
    x.attributes.damage=Math.trunc(startConfig.enemy.minDamage+(startConfig.enemy.maxDamage-startConfig.enemy.minDamage)*damageInc);
    x.attributes.speed=startConfig.enemy.minSpeed+(startConfig.enemy.maxSpeed-startConfig.enemy.minSpeed)*speedInc;
    x.attributes.maxHealth=Math.trunc(startConfig.enemy.minHealth+(startConfig.enemy.maxHealth-startConfig.enemy.minHealth)*healthInc);

    return x;
  }
  target=null;
  targetCurrentNode;
  path;
  pathTraveled = 0;
  pathCurve = null;
  attackPoint;
  inCooldown = false;
  health = startConfig.enemy.maxHealth;
  seekTimer = new THREE.Clock();
  attributes={
    maxHealth:startConfig.enemy.maxHealth,
    speed:startConfig.enemy.speed,
    damage:startConfig.enemy.damage,
    attackRate:1.2,
    size:new THREE.Vector3(1,2,1)
  }
  /**
   * Find nearest player
   * @param {Player[]} players  - all players in the game
   * */
  findTarget(players){
    var minVal
    var minT=null;
    for(let p of players){
      if(p.dead)continue;
      var tmpVal=this.position.distanceTo(p.position);
      if(minT == null || tmpVal<minVal){
        minT = p;
        minVal = tmpVal;
      }
    }
    if(minT!=null){
      this.target = minT;
    }
  }
  /**
   * Moves the enemy toward its target
   * Generates a path
   * @param {Number} delta - time elapsed in seconds 
   */
  move(delta){
    if(this.attacking)return;
    if(this.seekTimer.getElapsedTime() >= 10 || this.target.dead){
      this.findTarget(this.game.players.values());
      this.seekTimer.start()
    }
    //no target, try again
    if(this.target==null)return;
    var isInLineOfSight = true;
    if(this.target!=null){
      var ray = new THREE.Ray(this.position, new THREE.Vector3().subVectors(this.target.position, this.position).normalize())
      for(var ob of this.game.scene.filter(x=> this.position.distanceTo(new THREE.Vector3(x.center.x, 0, x.center.z)) < this.position.distanceTo(this.target.position))){
        if(ray.intersectsBox(ob.box)){
          //target between obstacle
          isInLineOfSight = false;
          break;
        }
      }

      if((this.targetCurrentNode == undefined || this.target.currentNode.id != this.targetCurrentNode.id) && this.path==null && !isInLineOfSight){
        //find shortest path
        this.path = this.game.astar(this.currentNode.id, this.target.currentNode.id);
        this.targetCurrentNode = this.game.nodes.find(x=>x.id == this.path[0]);
      }
    }
    //generate path between enemy and target
    if(!isInLineOfSight && this.pathCurve==null && this.path != null){
      var points = [new THREE.Vector2(this.position.x, this.position.z)];
        for(let i = this.path.length-1; i > 0; i--){
          var curr = this.game.astarNodes.get(this.path[i]);
          var next = this.game.astarNodes.get(this.path[i-1]);
          var bx1=(curr.box.min.x>next.box.min.x)?curr.box.min.x:next.box.min.x;
          var bx2=(curr.box.max.x<next.box.max.x)?curr.box.max.x:next.box.max.x;
          var bz1=(curr.box.min.z>next.box.min.z)?curr.box.min.z:next.box.min.z;
          var bz2=(curr.box.max.z<next.box.max.z)?curr.box.max.z:next.box.max.z;
          var side = curr.neighbours.find(x=> x[0] == next.id)[1];
          bx1 = THREE.MathUtils.clamp(bx1+pathDiff, bx1, bx2);
          bx2 = THREE.MathUtils.clamp(bx2-pathDiff, bx1, bx2);
          bz1 = THREE.MathUtils.clamp(bz1+pathDiff, bz1, bz2);
          bz2 = THREE.MathUtils.clamp(bz2-pathDiff, bz1, bz2);


          if(side == 0)
          points.push( new THREE.Vector2( THREE.MathUtils.clamp((i<5)?this.target.position.x:(bx1+bx2)/2, bx1, bx2), curr.box.min.z ) );
          if(side == 1)
          points.push( new THREE.Vector2( THREE.MathUtils.clamp((i<5)?this.target.position.x:(bx1+bx2)/2, bx1, bx2), curr.box.max.z ) );
          if(side == 2)
          points.push( new THREE.Vector2( curr.box.min.x, THREE.MathUtils.clamp((i<5)?this.target.position.z:(bz1+bz2)/2, bz1, bz2) ) );
          if(side == 3)
          points.push( new THREE.Vector2( curr.box.max.x, THREE.MathUtils.clamp((i<5)?this.target.position.z:(bz1+bz2)/2, bz1, bz2) ) );

          if(i-1 == 0){
            points.push( next.position );
          }
        }
        this.pathCurve = new THREE.SplineCurve(points);
        this.pathTraveled=0;
    }
    var t= new THREE.Vector3(0,0,0);
    //in line of sight - move towards the target
    if(isInLineOfSight || this.currentNode.id == this.targetCurrentNode.id){
      t = new THREE.Vector3().subVectors(this.target.position, this.position).setLength(this.attributes.speed*delta);
      this.pathCurve = null;
      this.path = null;
    }else if(this.pathCurve!=null){// not in line of sight - move to the next point on the generated path
      this.pathTraveled+=this.attributes.speed*delta;
      var nxtPoint = this.pathCurve.getPointAt(THREE.MathUtils.clamp(this.pathTraveled/this.pathCurve.getLength(),0,1));
      t = new THREE.Vector3(nxtPoint.x, 0, nxtPoint.y).sub(this.position);
    }
    this.rotation = new THREE.Euler(0,Math.atan2(t.x,t.z),0);
    this.position.add(t);

    if(!this.attributes.size)this.attributes.size = new THREE.Vector3(1,2,1);
    this.model.geometry.boundingBox.setFromCenterAndSize(this.position, this.attributes.size);

    //check if node switched to remove from path
    var node = this.game.nodes.find(n=>  this.position.x >= n.x1  && this.position.x <= n.x2  && this.position.z >= n.z1  && this.position.z <= n.z2)
    if(node!= undefined && this.currentNode.id != node.id){

      if(this.path != undefined && this.path[this.path.length-2] == node.id){
        this.path.pop();
        if(this.path.length<=1)//in goal node
          this.path==null;
      }
    }
    this.currentNode = (node == undefined)?this.currentNode:node;

  }
  /**
   * Attacks the target if near it
   * @param {Number} delta - time elapsed in seconds 
   */
  attack(delta){
    if(!this.attacking){
      if(this.position.distanceTo(this.target.position)<0.75){
        this.attacking = true;
        this.attackPoint = this.target.position.clone();
        this.attackDelta=0;
      }
    }else{
        this.attackCheck(delta);
    }
  }
  /**
   * Checks if enough time has passed to attack the target
   * If the target is still near the attack point then it is damaged
   * @param {Number} delta - time elapsed in seconds 
   */
  attackCheck(delta){
    this.attackDelta+=delta;
    //time elapsed is greater than set
    if(this.attackDelta>(35/40)*this.attributes.attackRate){
      //if target still in area damage him
      if(!this.inCooldown && this.attackPoint.distanceTo(this.target.position)<1 && !this.target.dead){
        this.target.changeHP(-this.attributes.damage);
        //attack was made, wait for animation to finish
        this.inCooldown=true;
      }
      //keep attacking if target is in range
      this.attacking = this.position.distanceTo(this.target.position)<1 && !this.target.dead;
      if(this.attacking){
        var t = new THREE.Vector3().subVectors(this.target.position, this.position).normalize();
        this.rotation = new THREE.Euler(0,Math.atan2(t.x,t.z),0);
        this.attackPoint = this.target.position.clone();
      }
      //reset timers when attack ends
      if(this.attackDelta>this.attributes.attackRate){
        this.attackDelta=0;
        this.inCooldown=false;
      }

    }
  }
  /**
   * Sets health
   */
  setHP=()=>{
    this.health=this.attributes.maxHealth;
  }
  /**
   * Removes health from this enemy and gives point to the attacker
   * Sets enemy death flag
   * @param {Number} damage - damage amount
   * @param {Player} attacker - The attacker
   */
  takeDamage(damage, attacker){
    this.health-=damage;
    if(this.health>=0) attacker.points+=damage;
    else attacker.points+=damage-this.health;
    this.dead = this.health<=0;
    if(this.dead) attacker.kills++;
  }

  /**
   * send only required data to the socket
   * @returns data
   */
  convertToSendableData(){
    return {
      id: this.id,
      health: this.health,
      attributes:this.attributes,
      attacking:this.attacking,
      position:{
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
      rotation:{
        x: this.rotation.x,
        y: this.rotation.y,
        z: this.rotation.z,
      },
      currentNode:this.currentNode,
      dead:this.dead,
      path:this.pathCurve,
    }
  }
  /**
   * Gets all the data needed for a save file
   * @returns save data
   */
  getSaveData(){
    return {
      id: this.id,
      health: this.health,
      attributes:this.attributes,
      attackDelta:this.attackDelta,
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
      rotation: {
        x: this.rotation.x,
        y: this.rotation.y,
        z: this.rotation.z,
      },
      dead: this.dead,
    }
  }
  /**
   * Loads the save data into the enemy
   * @param {*} data - save data 
   * @returns 
   */
  load(data){
    if(data==undefined)return;
    this.id = data.id;
    this.health = data.health;
    this.attributes = data.attributes;
    this.attackDelta = data.attackDelta;
    this.position = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    this.rotation = new THREE.Euler(data.rotation.x, data.rotation.y, data.rotation.z);
    this.dead = data.dead;
    var node = this.game.nodes.find(n=>  this.position.x >= n.x1  && this.position.x <= n.x2  && this.position.z >= n.z1  && this.position.z <= n.z2)
    this.currentNode = (node == undefined)?this.currentNode:node;
    
    this.seekTimer.start();
    this.seekTimer.elapsedTime=10;
  }
}
const directions={
  forward: new THREE.Vector3().set(direction.x, direction.y, direction.z),
  backward: new THREE.Vector3().set(-direction.x, -direction.y, -direction.z),
  left: new THREE.Vector3().set(-direction.x, direction.y, direction.z),
  right: new THREE.Vector3().set(direction.x, direction.y, -direction.z),
}

class Player extends Character{
  nickname;
  number;
  image;
  color;
  ammo = startConfig.player.ammo;
  mag = startConfig.player.mag;
  health = startConfig.player.maxHealth;
  points = 0;
  kills = 0;
  reloading = false;
  reloadingClock = new THREE.Clock();
  connected = false;
  ready = false;
  raycaster = new THREE.Raycaster();
  ray = new THREE.Ray();
  shots = []//pos player, pos bullet end, 
  game;
  constructor(id, nickname, model, color, image, spawnPoint, game) {
    super()
    this.id = id;
    this.nickname = nickname;
    this.game = game;
    this.model = model.clone();
    this.model.traverse(function(object) {

      if ( object.isMesh ) {

        object.geometry = object.geometry.clone();

      }

  });
    this.color = color;
    this.image = image;
    this.position = spawnPoint;
    var sizeVec = new THREE.Vector3();
    model.geometry.boundingBox.getSize(sizeVec);
    this.model.geometry.boundingBox.setFromCenterAndSize(spawnPoint, new THREE.Vector3(0.75,1.75,0.75));
    this.model.geometry.computeBoundingSphere();
    this.model.position.copy(spawnPoint);
    this.number=this.game.players.size
  }
  actions = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    reload: false,
    fire: false,
  }
  upgradeCost = {
    player: 10,
    weapon: 10,
  }
  attributes = {
    maxHealth: startConfig.player.maxHealth,
    speed: startConfig.player.speed,
    damage: startConfig.player.damage,
    magSize: startConfig.player.magSize,
    firerate: startConfig.player.firerate,// attack/second
    reloadingTime: startConfig.player.reloadingTime,
  }
  /**
   * Returns data that does not change during the game
   */
  getStaticData(){
    return {
      nickname: this.nickname,
      image: this.image,
      color: this.color,
    }
  }
 
  /**
   * send only required data to the socket
   * @returns data
   */
  convertToSendableData(){
    //send shots and clear them
    var sendShots = this.shots.splice(0, this.shots.length);
    this.shots=[];
    return {
      id: this.id,
      ammo: this.ammo,
      mag: this.mag,
      health: this.health,
      points: this.points,
      reloading: this.reloading,
      upgradeCost:this.upgradeCost,
      attributes:this.attributes,
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
      rotation: {
        x: this.rotation.x,
        y: this.rotation.y,
        z: this.rotation.z,
      },
      currentNode: this.currentNode,
      shots: sendShots,
      dead: this.dead,
    }
    
  }
  /**
   * Gets all the data needed for a save file
   * @returns save data
   */
  getSaveData(){
    return {
      id: this.id,
      number: this.number,
      nickname: this.nickname,
      ammo: this.ammo,
      mag: this.mag,
      health: this.health,
      points: this.points,
      upgradeCost:this.upgradeCost,
      attributes:this.attributes,
      attackDelta:this.attackDelta,
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
      rotation: {
        x: this.rotation.x,
        y: this.rotation.y,
        z: this.rotation.z,
      },
      shots: this.shots,
      dead: this.dead,
    }
  }
  /**
   * Loads the save data into the enemy
   * @param {*} data - save data 
   * @returns 
  */
  load(data){
    if(data==undefined)return;
    this.id = data.id
    this.number = data.number
    this.nickname = data.nickname
    this.ammo = data.ammo
    this.mag = data.mag
    this.health = data.health
    this.points = data.points
    this.upgradeCost = data.upgradeCost
    this.attributes = data.attributes
    this.attackDelta = data.attackDelta
    this.position = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    this.rotation = new THREE.Euler(data.rotation.x, data.rotation.y, data.rotation.z);
    this.model.position.copy(this.position);
    this.shots = data.shots;
    this.dead = data.dead;
    var node = this.game.nodes.find(n=>  this.position.x >= n.x1  && this.position.x <= n.x2  && this.position.z >= n.z1  && this.position.z <= n.z2)
    this.currentNode = (node == undefined)?this.currentNode:node;
  }
  /**
   * Sets connected flag
   */
  connect(){
    this.connected = true;
  }
  /**
   * Sets connected flag
   */
  disconnect(){
    this.connected = false;
  }
  /**
   * Sets ready flag
   */
  setReady(ready){
    this.ready = ready;
  }
  /**
   * Upgrades an attribute and removes points from the player
   * @param {String} type - the type to upgrade 
   */
  upgrade(type){
    switch(type){
      case 'speed':{
        if(this.upgradeCost.player>this.points)return;
        this.attributes[type] = upgrades[type](this.attributes[type]);
        this.points-=this.upgradeCost.player;
        this.upgradeCost.player = Math.floor(this.upgradeCost.player *  1.7);
      }break;
      case 'maxHealth':
      {
        if(this.upgradeCost.player>this.points)return;
        this.attributes[type] = upgrades[type](this.attributes[type]);
        this.health+=10;
        this.points-=this.upgradeCost.player;
        this.upgradeCost.player = Math.floor(this.upgradeCost.player *  1.7);
      }break;
      case 'firerate':
      case 'magSize':
      case 'damage':
      {
        if(this.upgradeCost.weapon>this.points)return;
        this.attributes[type] = upgrades[type](this.attributes[type]);
        this.points-=this.upgradeCost.weapon;
        this.upgradeCost.weapon = Math.floor(this.upgradeCost.weapon *  1.7);
      }break;
    }
  }
  /**
   * Refills ammo in the mag and removes total ammo
   */
  reload(){
    var toReload = (this.attributes.magSize-this.mag);
    var toGive = (toReload>=this.ammo)?this.ammo:toReload;
    this.ammo-=toGive;
    this.mag+=toGive;
    this.reloading = false;
    this.reloadingClock.stop();
    this.attackTimer.start();
  }
  /**
   * Adds ammo
   * @param {Number} diff - ammo amount 
   */
  addAmmo(diff){
    this.ammo+=diff;
  }
  /**
   * Adds the health difference to the player
   * Sets death flag
   * @param {Number} diff - health amount 
   */
  changeHP(diff){
    this.health+=diff;
    if(this.health > this.attributes.maxHealth) this.health = this.attributes.maxHealth;
    this.dead = this.health<=0;
  }
  /**
   * Adds points
   * @param {Number} diff - point amount 
   */
  addPoints(diff=2){
    this.points+=diff;
  }
    /**
   * Adds kills
   * @param {Number} diff - kill amount 
   */
  addKills(){
    this.kills++;
  }
  /**
   * Executes actions that the user sets
   * Reloading and moving
   * Checks for collision during movement
   * @param {Number} delta - time difference in seconds 
   */
  executeActions(delta){
    if(this.actions.reload && this.mag != this.attributes.magSize){
      this.reloading = true;
      this.reloadingClock.start();
    }
    let sumVec = new THREE.Vector3(0,0,0);
    for(let d in directions){
      if(this.actions[d])sumVec.add(directions[d]);
    }
    sumVec.normalize();
    var speedModifier = 1 - (0.3+(THREE.MathUtils.clamp(this.game.enemies.filter(x=>x.position.distanceTo(this.position)<1).length, 0, 6)/10)); 
    this.model.position.addScaledVector(sumVec, this.attributes.speed*delta*speedModifier);
    this.model.geometry.boundingBox.setFromCenterAndSize(this.position, new THREE.Vector3(0.75,1.75,0.75));
    this.model.geometry.boundingSphere.set(this.position, 0.4);
    //if no intersections
    var pushVec=new THREE.Vector3();
    var collision = false;
    var myBbox = new THREE.Box3();
    this.model.geometry.boundingSphere.getBoundingBox(myBbox);
    for(let o of this.game.scene){
      if(o.id != this.id){
        //console.log(o.box);
      
        var obstacle =new THREE.Box3(o.box.min, o.box.max);
        if(this.model.geometry.boundingSphere.intersectsBox(obstacle)){
          var box = myBbox.intersect(obstacle);
          var center = new THREE.Vector3();
          box.getCenter(center)
          center.setY(0);
          pushVec.copy(this.model.position).sub(center).normalize();
          collision=true;
          break;
        }
      }
    }
    if(!collision){
      this.position.copy(this.model.position);  
    }else{
      this.model.position.copy(this.position.add(pushVec.multiplyScalar(0.1)));
    }
                   
    var node = this.game.nodes.find(n=>  this.position.x >= n.x1  && this.position.x <= n.x2  && this.position.z >= n.z1  && this.position.z <= n.z2)
    //console.log(this.game.nodes);
    this.currentNode = (node == undefined)?this.currentNode:node;
    this.model.geometry.boundingBox.setFromCenterAndSize(this.position,  new THREE.Vector3(0.75,1.75,0.75));
    for(let [id, p] of this.game.pickups){
      if(this.model.geometry.boundingBox.intersectsBox(p.box)){
        p.action(this);
        //this.game.pickups.delete(id);
      }
    }
    if(this.reloading && this.reloadingClock.getElapsedTime()>this.attributes.reloadingTime){
      this.reload();
    }
  }
  /**
   * Executes attack action
   * Summons a line in the direction the user is facing
   * Checks for collision along the line and if the target is an enemy it takes damage
   * Generates an attack if total time elapsed is greater than firerate
   * @param {Number} delta - time difference in seconds 
   */
  attack(delta){
    //total time elapsed
    this.attackDelta+=delta;
    if(this.actions.fire && !this.reloading && this.mag>0){
      while(this.attackDelta >= this.attributes.firerate){
        this.attackDelta -= this.attributes.firerate;//reduce timer
        this.mag--;//reduce ammo
        //get nearby obstacles 
        var objects = this.game.scene.filter(x=> this.position.distanceTo(new THREE.Vector3(x.center.x, 0, x.center.z)) < 22).map(x=>{return {type:"obstacle", box:x.box}});

        var nearestObject = null
        var noDist = 20;
        var hit = undefined;
        this.ray.set(this.position, new THREE.Vector3(0,0,1).applyEuler(this.rotation))
        //find nearest enemy to attack
        for(let no of objects.concat(this.game.enemies.map(x=>{return {type:"enemy", enemy:x, box:x.model.geometry.boundingBox}})).filter(o=> this.ray.intersectsBox(o.box))){
          let p = new THREE.Vector3();
          this.ray.intersectBox(no.box, p);
          let d = p.distanceTo(this.ray.origin);
          if(d<=noDist){
            hit = p.clone();
            noDist = d;
            nearestObject = no;
          }
        }
        if(hit != undefined){//found enemy to hit
          if(nearestObject.type == "enemy" && !nearestObject.enemy.dead){//nearest object was an enemy, reduce its health
            nearestObject.enemy.takeDamage(this.attributes.damage, this);
            if(nearestObject.enemy.dead){
              var rand = Math.random();
              //when enemy dies drops ammo, health or nothing
              if(rand <0.25) {
                var tmp = new HealthPickup(nearestObject.enemy.position.clone());
                this.game.pickups.set(tmp.id, tmp);
              }
              if(rand >=0.25 && rand < 0.50){
                var tmp = new AmmoPickup(nearestObject.enemy.position.clone());
                this.game.pickups.set(tmp.id, tmp);
              }
            }
          }
          this.shots.push({start: this.position, end: hit});
        }else{
          this.shots.push({start: this.position, end: this.ray.at(20, new THREE.Vector3())});
        }
        if(this.mag <= 0){
          this.reloading = true;
          this.reloadingClock.start(); 
          break;//no more ammo, dont shoot
        }
      }

    }else{
      //always reset the attack timer
      if (this.attackDelta>this.attributes.firerate) this.attackDelta = this.attributes.firerate;
    }
  }
}

class Node{
  constructor(id, position,neighbours, box) {
    this.id = id;
    this.position = position;
    this.box = box;
    this.neighbours = neighbours;
  }
  id;
  position;
  box;
  neighbours;
}

class Game{
  constructor(id, map) {
    console.log("created lobby "+id);
    //console.log(map);
    this.id = id;
    this.map = map;
    this.type = map.type;
    this.scene = map.data.navmesh.filter(n=> n.obstacle);
    this.nodes = map.data.navmesh.filter(n=> !n.obstacle);
    this.spawnNode = map.data.navmesh.find(n=> n.spawnNode);
    this.nodes.forEach(n => {
      this.astarNodes.set(n.id, new Node(n.id, new THREE.Vector2(n.center.x, n.center.z), n.neighbours/*.map(x=>x[0])*/, n.box));
    })
  }
  id;
  map;
  scene;
  pickups=new Map();
  nodes;
  astarNodes=new Map();
  worker;
  spawnNode;
  connections = [];
  players = new Map();
  enemies = [];
  enemySpawnDelta = 0;
  enemyWave = 1;
  playersReady = 0;
  leaveRetry = 5;
  executionFrequency = configuration.sendingFrequency;
  paused = false;
  goalReached = false;
  allDead = false;
  clock = new THREE.Clock();
  gameTime = 0;
  packetNumber = 0;
  /**
   * Sets the players and their spawn points.
   * @param {Player[]} players 
   */
  setPlayers(players){
    console.log("these can play");
    console.log(players.map(p=>p.nickname));
    for(let p of players){
      var model = playermodel.children[0].clone();
      var spawnPoint;
      if(this.spawnNode == undefined)spawnPoint = new THREE.Vector3(Math.random()*15,1,Math.random()*15);
      else spawnPoint = new THREE.Vector3().random().multiply(new THREE.Vector3(this.spawnNode.x2-this.spawnNode.x1, 0, this.spawnNode.z2-this.spawnNode.z1)).add(new THREE.Vector3(this.spawnNode.box.min.x,0,this.spawnNode.box.min.z));
      var newPlayer = new Player(p.id, p.nickname, model, p.color, p.image, spawnPoint, this);
      this.players.set(p.id, newPlayer);
    }
  }
  /**
   * Starts the game and the main game loop
   */
  start(){
    SocketServer.in(this.id).emit("start", {paused:this.paused});

    this.worker=setInterval(() => {
      var t1 = new Date();

      this.serverFunc();

      var t2 = new Date();
      if((t2.getTime()- t1.getTime()) > (1000/this.executionFrequency)){
        console.log("server cannot keep up");
        console.log("exe time is "+(t2.getTime()- t1.getTime()) +"ms vs "+1000/this.executionFrequency+"ms");
        //this.executionFrequency = t2.getTime()- t1.getTime();
      }
    }, 1000/this.executionFrequency);
    console.log("started "+this.id);
  }
  /**
   * Pauses the game
   * @param {String} reason 
   */
  pause(reason="Game paused"){
    this.paused = true;
    SocketServer.in(this.id).emit("pause", {paused:true, message:reason});
  }
  /**
   * Unpauses the game
   */
  unpause(){
    this.paused = false;
    SocketServer.in(this.id).emit("pause", {paused:false});
  }
  /**
   * Changes execution frequency
   * @param {Number} delta - difference in time
   */
  changeFrequency(delta){
    this.executionFrequency+=delta;
  }
  /**
   * Saves the game state
   * @returns saved game data
   */
  saveGame(){
    return {
      mapId: this.map.id,
      mapVersion: this.map.version,
      players: Array.from(this.players.values()).map(p=>p.getSaveData()),
      enemies: this.enemies.map(e=>e.getSaveData()),
      enemySpawnDelta: this.enemySpawnDelta,
      enemyWave: this.enemyWave
    }
  } 
  /**
   * Loads the game save
   * @param {*} data save data
   * @param {*} players players
   */
  loadSave(data, players){
    console.log("loading");
    //console.log(data);
    for(let p of data.players){
      var thePlayer = players.find(x=> x.id==p.id)
      if(thePlayer == undefined){

      }
      var newP = new Player(p.id, p.nickname, playermodel.children[0].clone(), p.color, p.image, p.position, this);
      newP.load(p);
      if(p.ready != undefined){
        newP.ready=p.ready;
        this.playersReady++;
      }
      this.players.set(p.id, newP);
    }
    for(var e of data.enemies){
      var newE = new Enemy(playermodel.children[0].clone(), this);
      newE.load(e);
      this.enemies.push(newE);
    }
    this.enemyWave = data.enemyWave;
    this.enemySpawnDelta = data.enemySpawnDelta;
  }
  /**
   * Main game loop
   * spawns enemies, executes player actions, checks if goal is reached/all players are dead
   */
  serverFunc() {

    var deltaTime =  this.clock.getDelta();
    this.enemySpawnDelta += deltaTime;
    debugDelta+=deltaTime;

    if(!this.paused && (!this.allDead || !this.goalReached)) {   
      this.gameTime+=deltaTime;
      this.allDead = true;
      for(const c of this.players.values()){  
        if(!c.dead){
          this.allDead = false;
          c.executeActions(deltaTime);
          c.attack(deltaTime);
        }
      }
      if(this.type=="campaign"){
        var inGoal = true;
        for(const c of this.players.values()){
          if(!c.currentNode.goalNode && !c.dead){
            inGoal = false;
            break;
          }
        }
        if(inGoal){
          this.goalReached=true;
          SocketServer.in(this.id).emit("goalReached", {goalReached:true, time: this.gameTime});
        }

      }
      if(!this.allDead){
        if(this.enemySpawnDelta>=1){
          this.enemyWave = Math.trunc(this.gameTime/10);
          var newEnemy=null;
          //spawn enemies every second until number of enemies is reached
          for(let i = 0; i < this.players.size && this.enemies.length < THREE.MathUtils.clamp(this.players.size*this.enemyWave*2,0,this.players.size*15); i++){
            if(newEnemy!=null)this.enemies.push(new Enemy(playermodel.children[0].clone(), this, newEnemy.currentNode));
            else {
              newEnemy=new Enemy(playermodel.children[0].clone(), this);
              this.enemies.push(newEnemy);
            }
          }
          this.enemySpawnDelta -= 1;
        }
        for(const e of this.enemies){
          e.move(deltaTime);
          e.attack(deltaTime);
        }  
      }else{
        this.goalReached=true;
        SocketServer.in(this.id).emit("goalReached", {goalReached:false, time: this.gameTime});
      }
      for(var [id, p] of this.pickups){
        p.duration-=deltaTime;
        if(p.duration<=0)p.pickedUp=true;
      }
      //send packets as volatile so no ack is needed
      SocketServer.volatile.in(this.id).emit("stateUpdate", {packetNumber: this.packetNumber, sentAt: new Date(), 
        players: Array.from(this.players.values()).map(val=>val.convertToSendableData()), 
        enemies: this.enemies.map(val=>val.convertToSendableData()), time:this.gameTime, 
        pickups: Array.from(this.pickups.values())}
      );
      this.packetNumber++;
      this.enemies = this.enemies.filter(e=> !e.dead);
      this.pickups.forEach(p => {if(p.pickedUp) this.pickups.delete(p.id);})

    }
    //every 5 seconds
    if(debugDelta>5 || this.goalReached){

      //leaving
      if(this.allDead || this.goalReached || !Array.from(this.players.values()).some(val => val.connected == true)){
        this.leaveRetry--;
        if(this.leaveRetry<0 ||this.goalReached){
          if (this.goalReached) {
            console.log("GOAL REACHED");
          }
          clearInterval(this.worker);
          console.log("Empty lobby "+this.id);
          SocketClient.emit('emptyLobby', {id:this.id});
          games.delete(this.id);
        }
      }else this.leaveRetry=5;

      debugDelta=0;
    }
  }
  /**
   * Generate path using astar between nodes
   * During generation if it collides with a node on an existing path joins the rest of the path if the colliding path has the same goal node 
   * @param {Number} fromNode - node id 
   * @param {Number} goalNode - node id 
   * @returns 
   */
  astar(fromNode, goalNode){

    var sameGoalEnemies = this.enemies.filter(e=> (e.path != undefined && e.path != null) && e.path.length>1 && e.path[0]==goalNode);


    var goal = this.astarNodes.get(goalNode)
    var open = [{node:this.astarNodes.get(fromNode), cost:0, heuristic:0, f:0, parent:null}];

    var closed = [];
    var path = null;
    while(open[0]!=undefined){
      var current = open.splice(0,1)[0];
      for(var e of sameGoalEnemies){
        var i = e.path.findIndex(n=>n == current.node.id);
        if(i!=-1){
          path = e.path.slice(0, i+1);
          var iter = current.parent;
          while(iter!=null){
            path.push(iter.node.id);
            iter = iter.parent;
          }
          break;//found
        }
      }
      if(path!=null)break;//found path from another enemy
      for(var next of current.node.neighbours){
        if(goalNode == next[0]){
          path = [];
          path.push(next[0]);
          path.push(current.node.id);
          var iter = current.parent;
          while(iter!=null){
            path.push(iter.node.id);
            iter = iter.parent;
          }
          break;//found
        }
        var nxtNode = this.astarNodes.get(next[0]);
        var tmp = {node:nxtNode, cost:current.cost+current.node.position.distanceTo(nxtNode.position), heuristic:nxtNode.position.distanceTo(goal.position), f:0, parent:current};
        tmp.f = tmp.cost+tmp.heuristic;
        if(open.length>0 && open.find(o=> o.node.id == tmp.node.id && o.f < tmp.f))continue;
        if(closed.length>0 && closed.find(o=> o.node.id == tmp.node.id && o.f < tmp.f))continue;
        open.push(tmp);
      }
      if(path!=null)break;//found path
      open.sort((a, b) => a.f - b.f);
      closed.push(current);
    }
    return path;
  }

}
var games = new Map();
SocketServer.on('connection', (socket) => {
  console.log('a user connected');
  //console.log(socket);
  console.log(socket.handshake.query);
  console.log(socket.handshake.query.gameId);
  console.log(socket.handshake.query.playerId);
  socket.on("disconnect", (reason) => {
   
  });

  socket.on("playerStateUpdate",(data) => {
    var game = games.get(socket.handshake.query.gameId);
    if(game != undefined){
      var player = game.players.get(socket.handshake.query.playerId);
      if(player != undefined){
        player.actions = data.actions;
        player.rotation.set(data.rotation._x, data.rotation._y, data.rotation._z)
        var recAt=new Date();
        appendFileSync(game.id+".log", "Recieved at "+recAt+"\t"+ player.id+"-"+player.nickname+"\t"+data.fps+"\t"+data.ping+"\tupMS: "+(recAt.getTime()-data.sentAt)+"\n");
      }
    }
  });
  socket.on("upgrade",(data) => {
    var game = games.get(socket.handshake.query.gameId);
    if(game != undefined){
      var player = game.players.get(socket.handshake.query.playerId);
      if(player != undefined){
        player.upgrade(data.upgradeType);
      }
    }
  });
  socket.on("pause",(data) => {
    var game = games.get(socket.handshake.query.gameId);
    //console.log(data);
    if(game != undefined){
      if(data.paused)game.pause(game.players.get(socket.handshake.query.playerId).nickname+" paused the game.");
      else game.unpause();
    }
  });
  socket.on("saveGame",(data, callback) => {
    var game = games.get(data.gameId);
    //console.log(data);
    if(game != undefined){
      if(game.paused){
        callback({error:false,data: game.saveGame()})
      }else{
        game.pause("Saving game");
        callback({error:false,data: game.saveGame()})
        game.unpause();
      }
    }
    callback({error:true,message:"Game not found"})
  });
  socket.on("createLobby", async (data, callback)=>{
    var map = cachedMaps.find(x=> x.id == data.mapId && x.version == data.mapVersion);
    var mapData;
    if(map == undefined) {
      console.log("map not found - downloading");
      var resp = await SocketClient.emitWithAck("requestMap", {mapId: data.mapId, mapVersion: data.mapVersion});
      cachedMaps.push({id: data.mapId, version: data.mapVersion, data: resp.map})
      if(cachedMaps.length>5){
        console.log("cache full - removing last");
        cachedMaps.shift();
      }
      mapData = resp.map;
    }else {
      console.log("found map in cache");
      cachedMaps.push(cachedMaps.splice(cachedMaps.findIndex(x=> x.id == data.mapId && x.version == data.mapVersion), 1)[0]);
      mapData = map.data;
    }
    //console.log(map);
    games.set(data.id, new Game(data.id, mapData));
    games.get(data.id).setPlayers(data.players)
    callback();
  });
  socket.on("createLoadLobby", async (data, callback)=>{
    var map = cachedMaps.find(x=> x.id == data.mapId && x.version == data.mapVersion);
    var mapData;
    if(map == undefined) {
      console.log("map not found - downloading");
      var resp = await SocketClient.emitWithAck("requestMap", {mapId: data.mapId, mapVersion: data.mapVersion});
      cachedMaps.push({id: data.mapId, version: data.mapVersion, data: resp.map})
      mapData = resp.map;
    }else {
      console.log("found map in cache");
      mapData = map.data;
    }
    //console.log(map);
    games.set(data.id, new Game(data.id, mapData));
    games.get(data.id).loadSave(data.loadData, data.players);
    callback();
  });
  socket.on("requestData", (data, callback)=>{
    console.log("reqda");
    //console.log(data);
    var mapData = {};
    var game = games.get(socket.handshake.query.gameId);

    mapData.map = game.map.data;
    mapData.map.type = game.type;
    mapData.players = Array.from(game.players.values()).map(val => {
      var ret = 
      { ...val.convertToSendableData(), ...val.getStaticData()}
      return ret;
    }); 
    mapData.configuration = configuration;
    callback(mapData)
  });
  socket.on("ping", (callback) => {
    console.log("PONG");
    callback();
  });
  socket.on("startGame", (data)=>{
    var game = games.get(socket.handshake.query.gameId);
    game.playersReady++;
    if(game.players.size == game.playersReady)
      game.start();
  });
  socket.on("ready", (data, callback)=>{
    var game = games.get(socket.handshake.query.gameId)
    if(game != undefined){
      var player = game.players.get(socket.handshake.query.playerId);
      if(player != undefined){
        if(!player.ready){
          player.setReady(true);
          game.playersReady++;
          if(game.players.size == game.playersReady){
            game.start();
          }
          callback({error:false,message:"ready"})
        }else{
          callback({error:false,message:"Already ready"});
          if(game.players.size == game.playersReady){
            socket.emit("start", {paused:game.paused});
          }
        }
      }
      else{
        callback({error:true,message:"This player is not in this game"});
      }
    }else{
      callback({error:true,message:"This game does not exist"})
    }

  });
  socket.on("joinLobby", (data, callback)=>{
    socket.join(socket.handshake.query.gameId)
    var game = games.get(socket.handshake.query.gameId)
    if(game != undefined){
      var player = game.players.get(socket.handshake.query.playerId);
      if(player != undefined){
        player.connect();
      }
      else{
        callback({error:true,message:"This player is not in this game"});
      }
    }else{
      callback({error:true,message:"This game does not exist"})
    }
    callback({error:false,message:"Connected"})
  });
});

server.listen(process.env.PORT || 5000, () => {
  console.log('listening on '+IP+":"+(process.env.PORT || 5000));
});
server.on('request', function(req, res) {
  // see all incoming requests here
  if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.write("Game server is running");
      res.end();
  }
});
var clock = new THREE.Clock();
var debugDelta = 0;

function debugLog(data){
  if(debugDelta>5)console.log(data);
}
