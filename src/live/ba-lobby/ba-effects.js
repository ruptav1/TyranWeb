// Character effects and blinking of Blue Archive's standing sprites, from ba-archive's Blue Archive
// story player: https://github.com/ba-archive/blue-archive (commit 4ddc9ee241f6028d724346acda190155dc98aaf6),
// lib/ba-story-player/lib/layers/characterLayer/actionPlayer.ts, options/actionOptions.ts and
// index.ts, and lib/utils.ts (hasAnimation).
// Copyright (C) ba-archive contributors. Licensed under the GNU Affero General Public License v3.0
// (the repository's licence; ba-story-player's own package says GPL-3.0); see LICENSE in TyranWeb.
//
// Taken as written, with only the TypeScript types left out, and only the parts the lobby uses: the
// five effects the game's lobby lines name (greeting, hophop, jump, shake, stiff), their settings,
// and the blinking. TyranWeb's lobby page gives them its character as `instance` and its rig as
// `instance.instance` (with x, y, width and height in the page's pixels, as a PIXI object has), and
// registers the "pixi" property gsap tweens them with (src/live/ba-lobby/player.js).
(() => {
  'use strict';
  const gsap = window.gsap;

  // ---- lib/utils.ts
  function hasAnimation(instance, animationName) {
    return instance.skeleton.data.animations.some(
      animation => animation.name === animationName
    );
  }

  // ---- characterLayer/options/actionOptions.ts (the five the lobby uses)
  const actionOptions = {
    hophop: {
      yOffset: 0.05,
      duration: 0.25,
    },
    greeting: {
      yOffset: -0.04,
      duration: 0.4,
    },
    shake: {
      shakeAnimation: {
        from: -0.03,
        to: 0.02,
        duration: 0.08,
        repeat: 2,
      },
    },
    stiff: {
      shakeAnimation: {
        from: -0.01,
        to: 0.01,
        duration: 0.08,
        repeat: 4,
      },
    },
    jump: {
      yOffset: 0.03,
      duration: 0.25,
    },
  };

  // ---- characterLayer/actionPlayer.ts
  const CharacterEffectPlayerInstance = {
    getHandlerFunction(type) {
      return Reflect.get(this, type);
    },
    processEffect(type, instance) {
      const fn = this.getHandlerFunction(type);
      if (!fn) {
        return new Promise((resolve, reject) => {
          reject();
        });
      }
      return fn(instance, actionOptions[type], []);
    },
    greeting(instance, options) {
      const tl = gsap.timeline();
      const yOffset = options.yOffset * instance.instance.height;
      tl.to(instance.instance, {
        pixi: { y: `-=${yOffset}` },
        repeat: 1,
        yoyo: true,
        duration: options.duration / 2,
      });

      return timeLinePromise(tl);
    },
    hophop(instance, options) {
      const tl = gsap.timeline();
      const yOffset = options.yOffset * instance.instance.height;
      tl.to(instance.instance, {
        pixi: { y: `-=${yOffset}` },
        repeat: 3,
        yoyo: true,
        duration: options.duration / 2,
      });

      return timeLinePromise(tl);
    },
    jump(instance, options) {
      const tl = gsap.timeline();
      const yOffset = options.yOffset * instance.instance.height;
      tl.to(instance.instance, {
        pixi: { y: `-=${yOffset}` },
        repeat: 1,
        yoyo: true,
        duration: options.duration / 2,
      });

      return timeLinePromise(tl);
    },
    shake(instance, options) {
      const tl = gsap.timeline();
      const fromX = options.shakeAnimation.from * instance.instance.width;
      const toX = options.shakeAnimation.to * instance.instance.width;
      tl.to(instance.instance, {
        pixi: { x: `+=${fromX}` },
        repeat: 1,
        yoyo: true,
        duration: options.shakeAnimation.duration / 2,
      })
        .to(instance.instance, {
          pixi: { x: `+=${toX}` },
          repeat: 1,
          yoyo: true,
          duration: options.shakeAnimation.duration / 2,
        })
        .repeat(options.shakeAnimation.repeat - 1);

      return timeLinePromise(tl);
    },
    stiff(instance, options) {
      const tl = gsap.timeline();
      const fromX = options.shakeAnimation.from * instance.instance.width;
      const toX = options.shakeAnimation.to * instance.instance.width;
      tl.to(instance.instance, {
        pixi: { x: `+=${fromX}` },
        repeat: 1,
        yoyo: true,
        duration: options.shakeAnimation.duration / 2,
      })
        .to(instance.instance, {
          pixi: { x: `+=${toX}` },
          repeat: 1,
          yoyo: true,
          duration: options.shakeAnimation.duration / 2,
        })
        .repeat(options.shakeAnimation.repeat - 1);

      return timeLinePromise(tl);
    },
  };

  async function timeLinePromise(
    tl,
    callBack
  ) {
    await tl;

    if (callBack) {
      callBack();
    }
  }

  // ---- characterLayer/index.ts (blinking)
  const AnimationWinkTrack = 1; // TODO 眨眼动画

  /**
   * 眨眼
   *
   * 至少游戏里只会眨一次或者两次
   *
   * 固定只有01表情时才会眨眼
   * @param instance 要眨眼的角色结构体
   * @param first 是否为改变表情时的初始化
   */
  function wink(instance, first = true) {
    //只在有眨眼动画时起作用
    if (!hasAnimation(instance.instance, "Eye_Close_01")) {
      return;
    }
    const face = instance.currentFace;
    const spine = instance.instance;
    clearWinkHandler(instance.winkObject);
    if (face !== "01") {
      return;
    }
    const winkTimeout = Math.floor(Math.random() * 1000) + 3500;
    instance.winkObject = {
      handler: window.setTimeout(wink, winkTimeout, instance, false),
    };
    if (first) {
      return;
    }
    const loopTime = Math.floor(Math.random() * 2) + 1;
    const winkAnimationObject = loopAnimationTime(
      spine.state,
      AnimationWinkTrack,
      "Eye_Close_01",
      "eye",
      loopTime
    );
    instance.winkObject.animationObject = winkAnimationObject;
    winkAnimationObject.start();
  }

  /**
   * 指定循环次数的播放循环动画
   *
   * 通过AnimationStateListener在每次播放结束后判断播放次数,
   *
   * 如果没有达到次数就继续播放
   * @param state spine的state对象
   * @param trackIndex 动画的trackIndex
   * @param animationName 动画的animationName
   * @param id 用于标识loop handler的key
   * @param loop 循环次数
   */
  function loopAnimationTime(
    state,
    trackIndex,
    animationName,
    id,
    loop
  ) {
    return {
      _pause: false,
      start() {
        const controller = state.listeners.filter(
          it => Reflect.get(it, "complete") && Reflect.get(it, "key") === id
        );
        if (controller.length !== 0) {
          state.removeListener(controller[0]);
        }
        let loopCount = 1;
        const listener = {
          complete: (entry) => {
            if (entry.trackIndex !== trackIndex) {
              return;
            }
            if (loopCount < loop && !this._pause) {
              loopCount++;
              state.setAnimation(trackIndex, animationName, false);
            }
          },
          key: id,
        };
        state.addListener(listener);
        state.setAnimation(trackIndex, animationName, false);
      },
      pause() {
        this._pause = true;
      },
    };
  }

  function clearWinkHandler(winkObject) {
    if (!winkObject) {
      return;
    }
    if (winkObject.handler) {
      window.clearTimeout(winkObject.handler);
      winkObject.handler = 0;
    }
    winkObject.animationObject?.pause();
  }

  window.BAEffects = { CharacterEffectPlayerInstance, actionOptions, wink, clearWinkHandler, hasAnimation };
})();
