/*!
 * sinaads
 * 新浪统一商业广告脚本
 * 负责使用pdps(新浪广告资源管理码)向广告引擎请求数据并处理广告渲染
 * @author acelan <xiaobin8[at]staff.sina.com.cn>
 * @version 1.0.0
 * @date 2013-08-08
 */

 /** 
  * @useage
  *     window.sinaadsPreloadData = [pdps1, pdps2, pdps3, ..., pdpsn]; 批量加载的代码
  *     (window.sinaads = window.sinaads || []).push({}); 投放一个位置
  *     (window.sinaads = window.sinaads || []).push({
  *         element : HTMLDOMElement,
  *         params : {
  *             sinaads_ad_width : xx,
  *             sinaads_ad_height : xxx,
  *             sinaads_ad_pdps : xxxx,
  *             ...
  *         }
  *     });
  *
  *
  * @info
  *    _sinaadsTargeting : 保存本页中的定向信息
  *    _SINAADS_CONF_SAX_REQUEST_TIMEOUT = 10 //设置sax请求超时时间，单位秒
  *    _SINAADS_CONF_PAGE_MEDIA_ORDER = [] //广告展现顺序配置，PDPS列表
  *    _SINAADS_CONF_PRELOAD = [] //预加载的广告pdps列表
  */
window._sinaadsIsInited = window._sinaadsIsInited || (function (window, core, undefined) {
    "use strict";

    core.debug('sinaads:Init sinaads!');

//页面url转换成唯一hash值，用于标记页面唯一的广告位
var UUID = 1;
var PAGE_HASH = 'sinaads_' + core.hash(window.location.host.split('.')[0] + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')));
var IMPRESS_URL = 'http://sax.sina.com.cn/newimpress'; //向广告引擎请求正式广告的地址
var SERVER_PREVIEW_IMPRESS_URL = 'http://sax.sina.com.cn/preview'; //向广告引擎请求服务端预览广告的地址
var SAX_TIMEOUT = parseInt(window._SINAADS_CONF_SAX_REQUEST_TIMEOUT || 30, 10) * 1000; //请求数据超时时间

var controllerModule = {
    /**
     * 频次控制模块
     */
    frequenceController : new core.FrequenceController(PAGE_HASH)
};
/**
 * 数据模块
 * @return {[type]} [description]
 */
var modelModule = (function (core, controller, uid) {
    var _cache = {};
    var serverPreviewSlots = {};
    var targeting;
    var enterTime = core.now();
    var seed = {};


    /**
     * 获取页面种子，用于根据是否有频率来获取相应的轮播数
     */
    function _getSeed(key) {
        var seedkey = uid + (controller.frequenceController.has(key) ? key : '');

        if (!seed[seedkey]) {
            seed[seedkey] = parseInt(core.storage.get(seedkey), 10) || core.rand(1, 100);
            //大于1000就从0开始，防止整数过大
            core.storage.set(seedkey, _cache[seedkey] > 1000 ? 1 : ++seed[seedkey], 30 * 24 * 60 * 60 * 1000); //默认一个月过期
        }
        return seed[seedkey];
    }

    // //** test 
    // window.removeSeed = function (key) {
    //     delete seed[uid + (controller.frequenceController.has(key) ? key : '')];
    // };

    // window.refreshEnterTime = function () {
    //     enterTime = core.now();
    // };
    // //test end


    /**
     * 根据是否是服务端预览的广告位来确定使用预览引擎地址还是正式引擎地址
     * @param  {String} pdps 需要判断的pdps字符串，如果是批量加载的pdps，必然是pdps,pdps,pdps格式，因此批量加载的不允许为预览位置，预览位置一定是单个请求
     * @return {String}      请求地址
     */
    function _getImpressURL(pdps) {
        if (serverPreviewSlots[pdps]) {
            core.debug('sinaads: ' + pdps + ' is server preview slot.');
            return SERVER_PREVIEW_IMPRESS_URL;
        }
        return IMPRESS_URL;
    }

    /**
     * 获取定向关键词, 全局只获取一次
     */
    function _getTargeting() {
        function clearEntryTag() {
            core.cookie.remove('sinaads_entry', {domain: '.sina.com.cn', path: '/'});
            core.storage.remove('sinaads_entry');
        }

        if (!targeting) {
            var metaNodes = document.getElementsByTagName('head')[0].getElementsByTagName('meta'),
                metas = {},
                meta,
                key,
                content,
                len = metaNodes.length,
                i = 0,
                entry,
                ip;

            targeting = {};
            /* 在meta中加入固定的keywords, 记录用户平台，屏幕尺寸，浏览器类型，是否移动端*/
            metas.keywords = [];
            /* 先将所有的meta节点的name和content缓存下来, 缓存是为了提高查找效率, 不用每次都去遍历 */
            for (; i < len; i++) {
                meta = metaNodes[i];
                if (meta.name) {
                    key = meta.name.toLowerCase();
                    content = core.string.trim(meta.content);
                    if (!metas[key]) {
                        metas[key] = [];
                    }
                    content && (metas[key].push(content));
                }
            }
            /* 拆解出name = ^sinaads_ 的key, 并得到真实的key值
             * 如果name=sinaads_key的content为空，则查找name=key的content作为内容
             */
            for (var name in metas) {
                if (name.indexOf('sinaads_') === 0) {
                    key = name.replace('sinaads_', ''); //因为以sinaads_开头，因此replace的一定是开头那个，不用使用正则/^sinaads_/匹配，提高效率
                    targeting[key] = metas[name].join(',') || metas[key].join(',');
                }
            }

            if ((entry = core.cookie.get('sinaads_entry') || core.storage.get('sinaads_entry'))) {
                targeting.entry = entry;
                /**
                 * @todo
                 * 这里有个问题，如果获取到entry后保存到全局，然后立刻清除，如果iframe里面的广告需要获取entry的话则获取不到
                 * 但是如果在unload的时候清除，可能会有用户没有关闭当前文章，又打开了另外一个文章，这时候entry也没有清除
                 * 所以最终使用了延时5s删除
                 */
                var timer = setTimeout(clearEntryTag, 5000);
                core.event.on(window, 'beforeunload', function () {
                    timer && clearTimeout(timer);
                    clearEntryTag();
                });
            }

            /* 模拟ip定向 */
            if ((ip = core.cookie.get('sinaads_ip') || core.storage.get('sinaads_ip'))) {
                targeting.ip = ip;
                core.cookie.remove('sinaads_ip');
                core.storage.remove('sinaads_ip');
            }

            core.debug('sinaads:Targeting init,', targeting);
        }
        return targeting;
    }

    function _adapter(ad) {
        var networkMap = {
                '1' : 'http://d3.sina.com.cn/litong/zhitou/union/tanx.html?pid=',
                '2' : 'http://d3.sina.com.cn/litong/zhitou/union/google.html?pid=',
                '3' : 'http://d3.sina.com.cn/litong/zhitou/union/yihaodian.html?pid=',
                '4' : 'http://d3.sina.com.cn/litong/zhitou/union/baidu.html?pid=',
                '5' : 'http://js.miaozhen.com/mzad_iframe.html?_srv=MZHKY&l='
            },
            size = ad.size.split('*'),
            engineType = ad.engineType;

        //旧格式数据，需要适配成新格式
        if (!ad.content && ad.value) {
            core.debug('sinaads:Old data format, need adapter(pdps)', ad.id);
            ad.content = [];
            core.array.each(ad.value, function (value) {
                if (engineType === 'network') {
                    value.content = {
                        src : [networkMap['' + value.manageType] + value.content + '&w=' + size[0] + '&h=' + size[1]],
                        type : ['url']
                    };
                }
                if (engineType === 'dsp' && parseInt(value.manageType, 10) !== 17) {
                    value.content = {
                        src : [value.content],
                        type : ['html']
                    };
                }
                ad.content.push(value.content);
            });
            delete ad.value;
        }

        //对新格式数据进行过滤，过滤掉content.src没有内容的广告
        ad.content = (function (contents) {
            var r = [];
            core.array.each(contents, function (content, i) {
                //如果src没有内容，则为空广告位
                var nullSrc = true;
                //如果src有内容，判断内容中是否有某个元素非空字符串，有非空即为非空字符串
                core.array.each(content.src, function (src) {
                    if (core.string.trim(src)) {
                        nullSrc = false;
                        return false;
                    }
                });
                //如果广告素材不为空，那么这是一个正常可用数据，进入过滤后的列表
                if (!nullSrc) {
                    r.push(content);
                } else {
                    core.debug('sinaads: The' + i + ' Ad Content src is null, via ' + ad.id);
                }
            });
            return r;
        })(ad.content);

        //对类型进行匹配
        core.array.each(ad.content, function (content, i) {
            var type, link;

            type = core.array.ensureArray(content.type);
            link = core.array.ensureArray(content.link);

            core.array.each(content.src, function (src, i) {
                type[i] = core.ad.getTypeBySrc(src, type[i]);
            });
            // 通栏  950*90 tl
            // 画中画 300*250 hzh
            // 矩形 250*230 jx
            // 短通栏 640*90 dtl
            // 大按钮 300*120 dan
            // 小按钮 240*120 xan
            // 跨栏 1000*90 kl
            // 背投  750*450 bt
            // 文字链 wzl
            ad.type = ({
                'lmt'   : 'stream',
                'kl'    : 'couplet',
                'sc'    : 'videoWindow',
                'hzh'   : 'embed',
                'tl'    : 'embed',
                'jx'    : 'embed',
                'dtl'   : 'embed',
                'an'    : 'embed',
                'dan'   : 'embed',
                'xan'   : 'embed',
                'wzl'   : 'textlink',
                'ztwzl' : 'zhitoutextlink',
                'qp'    : 'fullscreen',
                'fp'    : 'turning',
                'dl'    : 'float',
                'tip'   : 'tip',
                'bt'    : 'bp',
                'sx'    : 'follow',
                'kzdl'  : 'coupletExt'
            }[ad.type]) || ad.type || 'embed';

            ad.content[i] = content;
        });

        return ad;
    }

    function _request(pdps) {
        var start = core.now(),
            deferred = new core.Deferred(),
            params = [],
            isLoaded = false,
            _pdps = [];

        //判断pdps相关数据是否存在，如果存在，直接返回，否则，请求后渲染
        core.array.each(pdps, function (str) {
            isLoaded = !!_cache[str];
            if (isLoaded) {
                core.debug('sinaads:current pdps data is loaded, render immedietly. ', str, _cache[str]);
            } else {
                _pdps.push(str);
            }
        });

        if (isLoaded) {
            deferred.resolve();
        } else {
            var targeting = _getTargeting();

            core.debug('sinaads:current pdps data is unload, load immedietly. ' + _pdps.join(), _cache);
            
            params = [
                'adunitid=' + _pdps.join(','),                                 //pdps数组
                'rotate_count=' + _getSeed(_pdps.length > 1 ? '' : _pdps[0]),   //轮播数，批量加载使用普通rotator
                'TIMESTAMP=' + enterTime.toString(36),           //时间戳
                'referral=' + encodeURIComponent(core.url.top),                  //当前页面url
                'date=' + core.date.format(new Date(), 'yyyyMMddHH') //请求广告的本地时间, 格式2014020709
            ];


            for (var key in targeting) {
                params.push('tg' + key + '=' + encodeURIComponent(targeting[key]));
            }

            core.sio.jsonp(_getImpressURL(_pdps.join(',')) + '?' + params.join('&'), function (data) {
                if (data === 'nodata') {
                    core.debug('sinaads:' + _pdps.join() + '. No register in SAX. ');
                    deferred.reject();
                } else {
                    core.debug('sinaads:request data ready. ', params, core.now(), core.now() - start, data);
                    //缓存数据到list中
                    //这里每次循环都reject可能会有问题
                    var notAllContentNull = false; //是否此次请求所有的广告都没有内容
                    core.array.each(data.ad, function (ad) {
                        ad = _adapter ? _adapter(ad) : ad;
                        if (ad.content instanceof Array && ad.content.length > 0) {
                            _cache[ad.id] = ad;
                            notAllContentNull = true;
                        } else {
                            core.debug('sinaads:' + ad.id + '. cannot found data. ');
                        }
                    });
                    /**
                     * cookie mapping
                     * 每次请求如果有mapping需要对应就发送请求
                     * @type {Number}
                     */
                    core.array.each(data.mapUrl, function (url) {
                        core.debug('sinaads:data ready, send cookie mapping. ' + url, params, core.now());
                        url && core.sio.log(url, 1);
                    });
                    if (notAllContentNull) {
                        deferred.resolve();
                    } else {
                        deferred.reject();
                    }
                }
            }, {
                timeout : SAX_TIMEOUT,
                onfailure : function () {
                    core.debug('sinaads:request timeout, via ' + _pdps.join());
                    deferred.reject();
                }
            });
        }

        return deferred;
    }

    /**
     * 初始化页面广告原始数据
     */
    function _init(oninit) {
        //1、将页面上默认存在的数据填充到数据缓存中
        _cache = window._sinaadsCacheData || {};


        /**
         * 当广告位在iframe中是docuemnt.referrer获取不到hash的值，因此这里使用获取hash跟query的方法来进行保证
         */
        var _hash = (core.url.top.split('#')[1] || '').split('?')[0] || '',
            _query = (core.url.top.split('?')[1] || '').split('#')[0] || '',
            par = (_hash + '&' + _query)
                .replace(/</g, '')
                .replace(/>/g, '')
                .replace(/"/g, '')
                .replace(/'/g, '');

        /**
         * 2、将本地预览的数据填充到_cache中，url.hash，本地预览只支持一个广告位
         */
        (function () {
            var query = par.split('&'),
                preview = {},
                keys = ['pdps', 'src', 'size'], //必需有的key
                key,
                q;

            for (var i = 0, len = query.length; i < len; i++) {
                if ((q = query[i])) {
                    q = q.split('=');
                    if (q[0].indexOf('sinaads_preview_') === 0) {
                        key = q[0].replace('sinaads_preview_', '');
                        if (key && q[1] && !preview[key]) {
                            preview[key] = q[1];
                            core.array.remove(keys, key);
                        }
                    }
                }
            }
            //只有满足三个参数齐全才进行预览数据填充
            if (keys.length === 0) {
                core.debug('sinaads:Ad Unit ' + preview.pdps +  ' is for preview only. ', preview);
                //构造一个符合展现格式的数据放入到初始化数据缓存中
                _cache[preview.pdps] = {
                    content : [
                        {
                            src : decodeURIComponent(preview.src).split('|'),
                            link : (decodeURIComponent(preview.link) || '').split('|'),
                            monitor : (preview.monitor || '').split('|'),
                            pv : (preview.pv || '').split('|'),
                            type : (preview.type || '').split('|')
                        }
                    ],
                    size : preview.size,
                    id : preview.pdps,
                    type : preview.adtype || 'embed',
                    highlight : preview.highlight || false
                };
            }
        })();

        /**
         * 3、获取服务端预览的广告位pdps列表
         * #sinaads_server_preview=PDPS000000000001&sinaads_server_preview=PDPS000000000002
         */
        serverPreviewSlots = (function () {
            var query = par.split('&'),
                slots = {},
                key = 'sinaads_server_preview', //必需有的key
                q;
            for (var i = 0, len = query.length; i < len; i++) {
                if ((q = query[i])) {
                    q = q.split('=');
                    if (q[0].indexOf(key) === 0) {
                        slots[q[1]] = 1;
                    }
                }
            }
            return slots;
        })();


        /**
         * 4、预加载的服务端数据
         */
        var preloadData = [],
            originPreloadData = window._SINAADS_CONF_PRELOAD || [],
            i = 0,
            pdps;

        //@todo 从预加载列表里面去除需要服务端预览的数据
        while ((pdps = originPreloadData[i++])) {
            if (!serverPreviewSlots[pdps]) {
                preloadData.push(pdps);
            }
        }

        if (preloadData.length > 0) {
            core.debug('sinaads:Data preload of bulk requests. ' + preloadData.join(','));
            //预加载不允许加载频率不为0的请求，比如视窗，这个需要人工控制
            _request(preloadData, _getSeed()).done(oninit).fail(oninit);
        } else {
            oninit();
        }
    }

    return {
        init : _init,
        request : _request,
        get : function (pdps) {
            return (pdps ? _cache[pdps] : _cache);
        }
    };
})(core, controllerModule, PAGE_HASH);
/**
 * 渲染模块
 */
var viewModule = (function () {
    var handlerMap = window.sinaadsRenderHandler || {};


    /**
     * 注册渲染方法
     * @param  {[type]} type    [description]
     * @param  {[type]} handler [description]
     * @return {[type]}         [description]
     */
    function _register(type, handler) {
        !handlerMap[type] && (handlerMap[type] = handler);
    }

    function _render(type, element, width, height, content, config) {
        var handler = handlerMap[type],
            /**
             * _next {
             *     type:type, //有后续步骤，即需要进行格式化类型跟内容的后续操作
             *     content: content
             * }
             * 比如，一开始是couplet类型，当格式化后，让它按照embed方式来处理
             */
            _next;

        if ('function' === typeof handler) {
            _next = handler(element, width, height, content, config);
        }
        //上面的处理将媒体类型改变，按照新类型再执行一边render方法
        if (_next && (_next.type !== type)) {
            _render(_next.type, element, width, height, _next.content, config);
        }
    }
    
    return {
        render : _render, //渲染方法
        register : _register,  //注册方法
        handlerMap : handlerMap
    };
})();

(function (core, view) {
    /**
     * 创建常规广告的曝光请求html
     * @param  {[type]} element [description]
     * @param  {[type]} config  [description]
     * @return {[type]}         [description]
     */
    view.register('embed', function (element, width, height, content, config) {
        //暂时让embed只支持一个广告
        content = core.array.ensureArray(content);
        content = content[0];

        var uid         = config.sinaads_uid,
            type        = content.type || '',
            link        = content.link || '',
            src         = content.src || '',
            pdps        = config.sinaads_ad_pdps,
            tpl         = config.sinaads_ad_tpl || '',
            adContent;

        //移动端 尺寸按照实际容器尺寸获取
        element.style.display = 'block';
        var containerWidth = element.offsetWidth;
        height = containerWidth / width * height;
        width = containerWidth;
        var containerHeight = element.offsetHeight;
        if (containerHeight !== 0) {
            width = width * containerHeight / height ;
            height = containerHeight < height ? containerHeight : height;
        }

        /**
         * 自适应宽度, 针对图片和flash
         */
        if (containerHeight === 0 && (type[0] === 'flash' || type[0] === 'image')) {
            width = '100%';
            height = 'auto';
        } else {
            width += 'px';
            height += 'px';
        }

        element.style.cssText += ';overflow:hidden;text-decoration:none;';
        element.innerHTML = '<ins style="text-decoration:none;margin:0px auto;display:block;overflow:hidden;width:' + width + ';height:' + height + ';"></ins>';
        element = element.getElementsByTagName('ins')[0];

        adContent = src ? core.ad.createHTML(type, src, width, height, link, content.monitor, core.isFunction(tpl) ? tpl(0) : tpl) : ''; //广告内容， 如果没有src，则不渲染 

        if (tpl) {
            element.innerHTML  = adContent; //广告内容， 如果没有src，则不渲染
        } else {
            switch (type[0]) {
                case 'text' :
                case 'image' :
                case 'url' :
                case 'adbox' :
                case 'flash' :
                    element.innerHTML = adContent;
                    break;
                default :
                    //创建广告渲染的沙箱环境，并传递部分广告参数到沙箱中
                    core.sandbox.create(element, width, height, adContent, {
                        sinaads_uid             : uid,
                        sinaads_ad_pdps         : pdps,
                        sinaads_ad_width        : width,
                        sinaads_ad_height       : height
                    });
                    break;
            }
        }
        try {
            window.sinaadsROC.done(pdps);
        } catch (e) {}
    });
})(core, viewModule);
(function (core, view) {
    function _textLink(element, width, height, content, config) {
        var tpl = config.sinaads_ad_tpl || '',
            html = [];
        core.array.each(content, function (content, i) {
            html.push(core.ad.createHTML(content.type, content.src, 0, 0, content.link, content.monitor, core.isFunction(tpl) ? tpl(i) : tpl));
        });
        element.style.cssText += ';text-decoration:none';
        element.innerHTML = html.join('');
    }

    view.register('textlink', _textLink);
    view.register('zhitoutextlink', _textLink);
})(core, viewModule);

/**
 * 初始化方法
 * @return {[type]} [description]
 */
var _init = (function (core, model, view, controller) {
    /**
     * 判断是否为sina商业广告节点且为未完成状态
     */
    //1.class=sinaads 
    //2.data-sinaads-status !== "done"
    function _isPenddingSinaad(element) {
        return (/(^| )sinaads($| )/).test(element.className) && "done" !== element.getAttribute("data-ad-status");
    }

    /**
     * 判断是否为sina商业广告节点且为异步插入的节点
     */
    //1.class=sinaads 
    //2.data-ad-status === "async"
    function _isAsyncSinaAd(element) {
        return (/(^| )sinaads($| )/).test(element.className) && "async" === element.getAttribute("data-ad-status");
    }
    /**
     * 如果有id参数，则获取id为当前id的未渲染元素，如果没有提供id，则从现有的元素中获取一个待渲染广告元素
     * @param  {[type]} id [description]
     * @return {[type]}    [description]
     */
    function _getSinaAd(id) {
        var inss = document.getElementsByTagName("ins"),
            i = 0,
            len = inss.length,
            ins;
        for (ins = inss[i]; i < len; ins = inss[++i]) {
            if (_isPenddingSinaad(ins) && ((!id && !_isAsyncSinaAd(ins)) || ins.id === id)) {
                return ins;
            }
        }
        return null;
    }

    /**
     * 根据广告媒体类型渲染广告
     */
    function render(element, data, config) {
        if (!data) {
            core.debug('sinaads:' + config.sinaads_ad_pdps + ', Cannot render this element because the data is unavilable.');
            return;
        }
        var start = core.now(),
            size    = data.size.split('*'),
            width   = config.sinaads_ad_width || (config.sinaads_ad_width = Number(size[0])) || 0,
            height  = config.sinaads_ad_height || (config.sinaads_ad_height = Number(size[1])) || 0;

        core.array.each(data.content, function (content, i) {
            core.debug('sinaads:Processing the impression of the ' + (i + 1) + ' creative of ad unit ' + config.sinaads_ad_pdps);

            content.src    = core.array.ensureArray(content.src);
            content.link   = core.array.ensureArray(content.link);
            content.type   = core.array.ensureArray(content.type);
            //content.sinaads_content_index = i;  //带入该内容在广告中的序号
            
            var monitor = content.monitor,
                pv = content.pv,
                link = content.link;
                //pid = content.pid ? 'sudapid=' + content.pid : '';
                //pid = ''; //暂时封闭功能

            /* 解析曝光，并注入模版值，发送曝光 
               曝光还是需要使用iframe进行处理，因为有些曝光是通过地址引入一段脚本实现，如果用img log的话没法执行脚本，会丢失曝光
               比如allyes，在曝光连接会返回document.write('<img src="impress.log"/>')
               这里需要修改方案
            */
            core.array.each(pv, function (url, i) {
                pv[i] = core.monitor.parseTpl(url, config);
                core.debug('sinaads:Recording the impression of ad unit ' + config.sinaads_ad_pdps + ' via url ' + url);
                //修改下这里的曝光监测的log, 不需要使用随机参数发送，而是在曝光值替换的时候将{__timestamp__} 替换成当前值，因为可能有些第三方监测会直接把url
                //后面的内容当作跳转连接传递，造成allyes.com/url=http://d00.sina.com.cn/a.gif&_sio_kdflkf请求跳转后为http://d00.sina.com.cn/a.gif&_sio_kdflkf，这个连接是个404的请求
                pv[i] && core.sio.log(pv[i], 1);
            });
            /* 解析监控链接，注入模版， 后续使用*/
            core.array.each(monitor, function (url, i) {
                //为sax monitor兼容一定是二跳的方案
                if (url && (url.indexOf('sax.sina.com.cn\/click') !== -1 || url.indexOf('sax.sina.com.cn\/dsp\/click') !== -1)) {
                    url = url.replace(/&url=$/, '') + '&url=';
                }
                monitor[i] = core.monitor.parseTpl(url, config);
                core.debug('sinaads:Processing the click of ad unit ' + config.sinaads_ad_pdps + ' via url ' + url);
            });

            //如果存在pid为每个link加上pid
            core.array.each(link, function (url, i) {
                //link增加monitor处理
                link[i] = core.monitor.createTrackingMonitor(url, monitor);
                // var hashFlag,
                //     hash = '',
                //     left = url;
                // if (pid && url) {
                //     hashFlag = url.indexOf('#');
                //     if (hashFlag !== -1) {
                //         hash = url.substr(hashFlag);
                //         left = url.substr(0, hashFlag);
                //     }
                //     link[i] = left + (left.indexOf('?') !== -1 ? '&' : '?') + pid + hash;
                // }
            });
        });

        /** 
         * 按照媒体类型渲染广告
         */
        view.render(
            config.sinaads_ad_type || data.type,
            element,
            width,
            height,
            data.content,
            config
        );


        //如果需要高亮广告位，则在广告位外部加上高亮标记
        if (data.highlight && (config.sinaads_ad_type || data.type) === 'embed') {
            element.style.outline = '2px solid #f00';
        }

        core.debug('sinaads:Ads Rendering is complete. (pdps:' + config.sinaads_ad_pdps + ', time elpased:' + (core.now() - start) + 'ms)');
    }


    /**
     * 广告请求成功，有广告的情况下处理
     * @param  {[type]} element [description]
     * @param  {[type]} config  [description]
     * @return {[type]}         [description]
     */
    function _done(element, config) {
        var pdps = config.sinaads_ad_pdps,
            data = model.get(pdps);

        //增加广告加载结束标志sinaads-done
        core.dom.addClass(element, 'sinaads-done');

        //如果有频率限制，则在成功时写入频率限制数据
        controller.frequenceController.disable(pdps);

        render(element, data, config);
        core.isFunction(config.sinaads_success_handler) && config.sinaads_success_handler(element, data, config);
    }

    function _fail(element, config) {
        core.dom.addClass(element, 'sinaads-fail');
        /* 广告位不能为空 */
        if (config.sinaads_cannot_empty) {
            //@todo 渲染默认数据
            core.debug('Use Default ad data.');
        }
        core.isFunction(config.sinaads_fail_handler) && config.sinaads_fail_handler(element, config);
    }

    function _getRequestDoneHandler(element, config) {
        return function () {
            var delay = config.sinaads_ad_delay;
            //处理延时
            if (delay && (delay = parseInt(delay, 10))) {
                setTimeout(function () {
                    _done(element, config);
                }, delay * 1000);
            } else {
                _done(element, config);
            }
        };
    }
    function _getRequestFailHandler(element, config) {
        return function () {
            _fail(element, config);
        };
    }

    return function (conf) {
        var element = conf.element,    //广告容器
            config = conf.params || {};   //广告配置

        //从config.element中得到需要渲染的ins元素，如果没有，则获取页面上未完成状态的广告节点
        if (element) {
            if (!_isPenddingSinaad(element) && (element = element.id && _getSinaAd(element.id), !element)) {
                core.debug("sinaads:Rendering of this element has been done. Stop rendering.", element);
                return;
            }
            if (!("innerHTML" in element)) {
                core.debug("sinaads:Cannot render this element.", element);
                return;
            }
        //没有对应的ins元素, 获取一个待初始化的ins, 如果没有，抛出异常
        } else if (element = _getSinaAd(), !element) {
            core.debug("sinaads:Rendering of all elements in the queue is done.");
            return;
        }

        //置成完成状态，下面开始渲染
        element.setAttribute("data-ad-status", "done");

        //记录所在位置，留用
        var pos = core.dom.getPosition(element);
        element.setAttribute('data-ad-offset-left', pos.left);
        element.setAttribute('data-ad-offset-top', pos.top);

        //全局唯一id标识，用于后面为容器命名
        config.sinaads_uid = UUID++;

        //将data-xxx-xxxx,转换成sinaads_xxx_xxxx，并把值写入config
        //这里因为上面设置了data-ad-status属性, 所以sinaads-ad-status的状态也会被写入conf
        for (var attrs = element.attributes, len = attrs.length, i = 0; i < len; i++) {
            var attr = attrs[i];
            if (/data-/.test(attr.nodeName)) {
                var key = attr.nodeName.replace("data", "sinaads").replace(/-/g, "_");
                config.hasOwnProperty(key) || (config[key] = attr.nodeValue);
            }
        }

        //获取page_url 广告所在页面url
        config.sinaads_page_url = core.url.top;


        var pdps = config.sinaads_ad_pdps;
        //注册一个频率控制器
        controller.frequenceController.register(pdps, config.sinaads_frequence || 0);

        //如果该pdps不是处于禁止请求状态，发请求，否者直接进入失败处理
        if (!controller.frequenceController.isDisabled(pdps)) {
            model.request(pdps)
                .done(_getRequestDoneHandler(element, config))
                .fail(_getRequestFailHandler(element, config));
        } else {
            _fail(element, config);
        }
    };
})(core, modelModule, viewModule, controllerModule);


/**
 * 初始化数据模型，并在初始化完成后处理js加载成功之前压入延迟触发的广告位，
 * 并将后续广告压入方法置成内部初始化方法
 */
modelModule.init(function () {
    core.debug('sinaads:Begin to scan and render all ad placeholders.' + core.now());

    /* 在脚本加载之前注入的广告数据存入在sinaads数组中，遍历数组进行初始化 */
    var preloadAds = window.sinaads;
    if (preloadAds && preloadAds.shift) {
        for (var ad, len = 50; (ad = preloadAds.shift()) && 0 < len--;) {
            _init(ad);
        }
    }
    //在脚本加载之后，sinaad重新定义，并赋予push方法为初始化方法
    window.sinaads = {push : _init};
});

//导出一些变量
window.sinaadsRFC = controllerModule.frequenceController;
window._sinaadsCacheData = modelModule.get();
window.sinaadsRenderHandler = viewModule.handlerMap;

    return true; //初始化完成

})(window, window.sinaadToolkit);
